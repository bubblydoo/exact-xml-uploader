import { Command } from "commander";
import puppeteer, { ElementHandle, Page } from "puppeteer";
import path from "path";
import { promises as fs } from "fs";
import { URI as otpAuthUri } from "otpauth";
import { group } from "radash";
import kleur from "kleur";

const USERNAME = process.env.USERNAME;
const PASSWORD = process.env.PASSWORD;
const OTP_URI = process.env.OTP_URI;
const EXACT_DIVISION = process.env.EXACT_DIVISION;
const LOGIN_MODE = process.env.LOGIN_MODE;
const LOGIN_URL = process.env.LOGIN_URL;

if (LOGIN_MODE === "manual") {
  if (!EXACT_DIVISION || !LOGIN_URL) {
    throw new Error("Need EXACT_DIVISION env var");
  }
} else {
  if (!USERNAME || !PASSWORD || !EXACT_DIVISION) {
    throw new Error("Need USERNAME, PASSWORD and EXACT_DIVISION env vars");
  }
}

const keypress = async () => {
  process.stdin.setRawMode(true);
  return new Promise<void>((resolve) =>
    process.stdin.once("data", (data) => {
      const byteArray = [...data];
      if (byteArray.length > 0 && byteArray[0] === 3) {
        console.log("^C");
        process.exit(1);
      }
      process.stdin.setRawMode(false);
      resolve();
    })
  );
};

const program = new Command();

program
  .option("--login-only", "login only")
  .requiredOption("--dir <dir>", "xmls directory path")
  .option("--otp <otp>", "one-time password")
  .requiredOption("--tmp-dir <tmpDir>", "tmp directory path");

program.parse(process.argv);

const opts = program.opts();

(async () => {
  let page: Page;
  const userDataDir = path.resolve(opts.tmpDir, "cache", "user-data-dir");
  await fs.mkdir(userDataDir, { recursive: true });
  const today = new Date().toISOString().split("T")[0];
  const screenshotsDir = path.resolve(opts.tmpDir, "screenshots", today);
  const errorLogsDir = path.resolve(opts.tmpDir, "error-logs", today);
  const mode = opts.loginOnly ? "login" : "upload";
  await fs.mkdir(screenshotsDir, { recursive: true });
  await fs.mkdir(errorLogsDir, { recursive: true });

  const upload = async () => {
    const contents = (await fs.readdir(opts.dir)).filter((x) => x.endsWith(".xml"));

    if (!contents.length) throw new Error("No files");

    console.log("Uploading", contents.length, "files", "first one:", contents[0]);

    const allErrorLogs: string[][] = [];

    const browser = await launchBrowser(userDataDir);
    const page = await browser.newPage();
    await login(page);
    console.log("Current url", page.url());
    console.log("Logged in");

    const date = new Date().toISOString();

    for (const filepath of contents) {
      const fullPath = path.resolve(opts.dir, filepath);
      await page.goto(
        `https://start.exactonline.be/docs/XMLUpload.aspx?ui=1&Topic=GLTransactions&_Division_=${EXACT_DIVISION}`,
        { waitUntil: ["load", "networkidle2"] }
      );
      const fileInput: ElementHandle<HTMLInputElement> = (await page.$("#txtFile_Upload")) as any;
      if (!fileInput) throw new Error("No file input");
      await fileInput!.uploadFile(fullPath);
      console.log("⏳ Uploading", filepath);
      await page.click("#btnImport");
      await page.waitForNavigation({ timeout: 120000 });
      await page.screenshot({
        path: path.resolve(screenshotsDir, `${filepath}-${date}-errors.png`),
      });
      console.log("✅ Uploaded", filepath);
      await fs.rename(fullPath, `${fullPath}.uploaded`);

      await page.$eval("input[id=Messages1]", (el) => ((el as any).checked = true));
      await page.$eval("input[id=List_ps]", (el) => ((el as any).value = "250"));
      await page.click("#List_Show");
      // await page.waitForNavigation();
      await new Promise((res) => setTimeout(res, 2000));
      const errorRows = await page.evaluate(() => {
        return Promise.all(
          Array.from(document.querySelectorAll("#List_TableBody tr[class^=Data]")).map((tr) =>
            Promise.all(
              Array.from(tr.querySelectorAll("td")).map((td) => {
                const a: HTMLAnchorElement | null = td.querySelector("a[href^=SysAttachmentView]");
                if (!a) return td.innerText;
                const url = new URL(a.href);
                const attachmentId = url.searchParams.get("AttachmentID")!;
                const division = url.searchParams.get("_Division_")!;
                return fetch(
                  `https://start.exactonline.be/docs/XmlEvent.aspx?ID=${attachmentId}&_Division_=${division}`
                ).then((resp) => {
                  return resp.text().then((text) => {
                    const doc = new DOMParser().parseFromString(text, "text/xml");
                    const body = doc.querySelector("body")!.innerHTML.replace(/&gt;/g, ">").replace(/&lt;/g, "<");
                    const xml = new DOMParser().parseFromString(body, "text/xml");
                    if (!xml.querySelector("GLTransaction") || !xml.querySelector("Journal")) {
                      return "unknown";
                    }
                    const entry = xml.querySelector("GLTransaction")!.getAttribute("entry")!;
                    const journalCode = xml.querySelector("Journal")!.getAttribute("code")!;
                    return `${journalCode}-${entry}`;
                  });
                });
              })
            )
          )
        );
      });
      allErrorLogs.push(...errorRows.reverse());
      await fs.writeFile(
        path.resolve(errorLogsDir, `${filepath}-${date}-errors.json`),
        JSON.stringify(errorRows, null, 2)
      );
      await page.screenshot({
        path: path.resolve(screenshotsDir, `${filepath}-${date}-errors.png`),
      });
      if (errorRows.length) {
        console.log("❌ Errors for", filepath);
        printErrorsSummary(errorRows);
      }
    }

    if (allErrorLogs) {
      console.log("❌ All errors");
      printErrorsSummary(allErrorLogs);
    }

    await fs.writeFile(path.resolve(errorLogsDir, `${date}-all-errors.json`), JSON.stringify(allErrorLogs, null, 2));
    await fs.writeFile(
      path.resolve(errorLogsDir, `${date}-all-errors.csv`),
      allErrorLogs.map((l) => l.join(";")).join("\n")
    );
    console.log("Done");
    await browser.close();
  };

  try {
    if (mode === "login") {
      const browser = await launchBrowser(userDataDir);
      page = await browser.newPage();
      await login(page);
      await new Promise(() => {});
    } else if (mode === "upload") {
      await upload();
    }
  } catch (e: any) {
    console.error("❌", e);
    if (e?.message?.includes("Navigation")) {
      await upload();
    } else {
      await page!?.screenshot({
        path: path.resolve(screenshotsDir, `error-${new Date().toISOString()}.png`),
      });
      throw e;
    }
  }
})();

async function launchBrowser(userDataDir: string) {
  const browser = await puppeteer.launch({
    headless: process.env.HEADLESS === "true",
    userDataDir,
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage", // <-- add this one
    ],
  });
  return browser;
}

async function login(page: Page) {
  console.log("Going to login page");
  if (LOGIN_MODE === "manual") {
    await page.goto(LOGIN_URL!, {
      waitUntil: ["load", "networkidle2"],
    });
    await new Promise((res) => setTimeout(res, 1000));
    if (!page.url().includes("MenuPortal.aspx")) {
      console.log("Please login and press any key to continue");
      await keypress();
    }
  } else {
    await page.goto("https://start.exactonline.be/docs/Login.aspx?Language=EN", {
      waitUntil: ["load", "networkidle2"],
    });
    await new Promise((res) => setTimeout(res, 2500));
    console.log("Current url", page.url());
    if (page.url().includes("Login.aspx")) {
      console.log("Logging in");
      const otp = opts.otp ?? (OTP_URI ? otpAuthUri.parse(OTP_URI).generate() : null);
      if (!otp) throw new Error("Not logged in, needs --otp or OTP_URI");
      await page.waitForSelector("[name='LoginForm$UserName']");
      await page.focus("[name='LoginForm$UserName']");
      await page.keyboard.type(USERNAME!);
      await page.keyboard.press("Enter");
      await page.waitForSelector("[name='LoginForm$Password']");
      await page.focus("[name='LoginForm$Password']");
      await page.keyboard.type(PASSWORD!);
      await page.keyboard.press("Enter");
      await page.waitForNavigation();
      if (page.url().includes("Totp")) {
        await page.waitForSelector("[name='LoginForm$Input$Key']");
        await page.click("[name='LoginForm$RememberDevice']");
        await page.focus("[name='LoginForm$Input$Key']");
        await page.keyboard.type(otp);
        await page.keyboard.press("Enter");
        await page.waitForNavigation();
      }
    }
    await new Promise((res) => setTimeout(res, 1000));
    if (page.url().includes("Login.aspx")) {
      throw new Error("Failed to login");
    }
  }
}

const parseErrorLine = (line: string[]) => {
  const [empty, date, code, type, entry, message, user] = line;
  // Topic [GLTransactions] Period is closed: 2023 - 4
  // Onderwerp [GLTransactions] Bestaat reeds - Boekstuknummer: 20713, Dagboek: VKUS,
  const md = message.match(/\] (.+)( - |:)/);
  return {
    date,
    code,
    type,
    entry,
    message,
    user,
    parsedMessage: md
      ? {
          type: md[1]?.split(":")[0].trim(),
        }
      : null,
  };
};

const printErrorsSummary = (errors: string[][]) => {
  const parsed = errors.map(parseErrorLine);
  const grouped = group(parsed, (x) => x.parsedMessage?.type ?? "unknown");
  for (const [type, lines] of Object.entries(grouped)) {
    console.log(type, lines.length);
  }
  console.log("Total errors", errors.length);
};
