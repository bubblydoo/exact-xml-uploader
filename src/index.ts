import { Command } from "commander";
import puppeteer, { ElementHandle } from "puppeteer";
import path from "path";
import { promises as fs } from "fs";

const USERNAME = process.env.USERNAME;
const PASSWORD = process.env.PASSWORD;
const EXACT_DIVISION = process.env.EXACT_DIVISION;

if (!USERNAME || !PASSWORD || !EXACT_DIVISION) {
  throw new Error("Need env vars");
}

const program = new Command();

program
  .requiredOption("--dir <dir>", "xmls directory path")
  .option("--otp <otp>", "one-time password")
  .requiredOption("--tmp-dir <tmpDir>", "tmp directory path");

program.parse(process.argv);

const opts = program.opts();

(async () => {
  const userDataDir = path.resolve(opts.tmpDir, "cache", "user-data-dir");
  await fs.mkdir(userDataDir, { recursive: true });
  const screenshotsDir = path.resolve(opts.tmpDir, "screenshots");
  const errorLogsDir = path.resolve(opts.tmpDir, "error-logs");
  await fs.mkdir(screenshotsDir, { recursive: true });
  await fs.mkdir(errorLogsDir, { recursive: true });

  const upload = async () => {
    const contents = (await fs.readdir(opts.dir)).filter((x) =>
      x.endsWith(".xml")
    );
    
    if (!contents.length) throw new Error("No files");

    console.log(
      "Uploading",
      contents.length,
      "files",
      "first one:",
      contents[0]
    );

    const allErrorLogs: string[][] = [];

    const browser = await puppeteer.launch({
      headless: process.env.HEADLESS === 'true',
      userDataDir,
      args: [
        "--no-sandbox",
        "--disable-dev-shm-usage", // <-- add this one
      ],
    });
    const page = await browser.newPage();
    console.log("Going to login page");
    await page.goto(
      "https://start.exactonline.be/docs/Login.aspx?Language=EN",
      {
        waitUntil: ["load", "networkidle2"],
      }
    );
    await new Promise((res) => setTimeout(res, 2500));
    console.log("Current url", page.url());
    if (page.url().includes("Login.aspx")) {
      console.log("Logging in");
      if (!opts.otp) throw new Error("Not logged in, needs --otp");
      await page.waitForSelector("#LoginForm_UserName");
      await page.focus("#LoginForm_UserName");
      await page.keyboard.type(USERNAME);
      await page.keyboard.press("Enter");
      await page.waitForSelector("#LoginForm_Password");
      await page.focus("#LoginForm_Password");
      await page.keyboard.type(PASSWORD);
      await page.keyboard.press("Enter");
      await page.waitForNavigation();
      if (page.url().includes("Totp")) {
        await page.waitForSelector("#LoginForm_Input_Key");
        await page.click("#LoginForm_RememberDevice");
        await page.focus("#LoginForm_Input_Key");
        await page.keyboard.type(opts.otp);
        await page.keyboard.press("Enter");
        await page.waitForNavigation();
      }
    }
    await new Promise((res) => setTimeout(res, 1000));
    console.log("Current url", page.url());
    if (page.url().includes("Login.aspx")) {
      throw new Error("Failed to login");
    }
    console.log("Logged in");

    const date = new Date().toISOString();

    for (const filepath of contents) {
      const fullPath = path.resolve(opts.dir, filepath);
      await page.goto(
        `https://start.exactonline.be/docs/XMLUpload.aspx?ui=1&Topic=GLTransactions&_Division_=${EXACT_DIVISION}`,
        { waitUntil: ["load", "networkidle2"] }
      );
      const fileInput: ElementHandle<HTMLInputElement> = await page.$("#txtFile") as any;
      await fileInput!.uploadFile(fullPath);
      console.log("Uploading", filepath);
      await page.click("#btnImport");
      await page.waitForNavigation({ timeout: 120000 });
      await page.screenshot({
        path: path.resolve(screenshotsDir, `${filepath}-${date}-errors.png`),
      });
      console.log("Uploaded", filepath);
      await fs.rename(fullPath, `${fullPath}.uploaded`);

      await page.$eval(
        "input[id=Messages1]",
        (el) => ((el as any).checked = true)
      );
      await page.$eval(
        "input[id=List_ps]",
        (el) => ((el as any).value = "250")
      );
      await page.click("#List_Show");
      await page.waitForNavigation();
      const errorRows = await page.evaluate(() => {
        return Promise.all(Array.from(
          document.querySelectorAll("#List_TableBody tr[class^=Data]")
        ).map((tr) =>
          Promise.all(Array.from(tr.querySelectorAll("td")).map((td) => {
            const a: HTMLAnchorElement | null = td.querySelector('a[href^=SysAttachmentView]');
            if (!a) return td.innerText;
            const url = new URL(a.href);
            const attachmentId = url.searchParams.get('AttachmentID')!;
            const division = url.searchParams.get('_Division_')!;
            return fetch(`https://start.exactonline.be/docs/XmlEvent.aspx?ID=${attachmentId}&_Division_=${division}`).then((resp) => {
              return resp.text().then((text) => {
                const doc = new DOMParser().parseFromString(text, 'text/xml');
                const body = doc.querySelector('body')!.innerHTML.replace(/&gt;/g, '>').replace(/&lt;/g, '<');
                const xml = new DOMParser().parseFromString(body, 'text/xml')
                const entry = xml.querySelector('GLTransaction')!.getAttribute('entry')!;
                const journalCode = xml.querySelector('Journal')!.getAttribute('code')!;
                return `${journalCode}-${entry}`;
              });
            });
          })
        )));
      });
      allErrorLogs.push(...errorRows.reverse());
      await fs.writeFile(
        path.resolve(errorLogsDir, `${filepath}-${date}-errors.json`),
        JSON.stringify(errorRows, null, 2)
      );
      await page.screenshot({
        path: path.resolve(screenshotsDir, `${filepath}-${date}-errors.png`),
      });
      console.log("Found", errorRows.length, "errors");
    }

    await fs.writeFile(
      path.resolve(errorLogsDir, `${date}-all-errors.json`),
      JSON.stringify(allErrorLogs, null, 2)
    );
    await fs.writeFile(
      path.resolve(errorLogsDir, `${date}-all-errors.csv`),
      allErrorLogs.map(l => l.join(';')).join('\n')
    );
    console.log("Done");
    await browser.close();
  };

  try {
    upload();
  } catch (e: any) {
    console.error(e);
    if (e?.message?.includes("Navigation")) {
      upload();
    } else {
      throw e;
    }
  }
})();
