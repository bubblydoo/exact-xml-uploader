import puppeteer from "puppeteer";
import { join } from "path";

const path = puppeteer.executablePath();

console.log(join(path, "../../Info.plist"));