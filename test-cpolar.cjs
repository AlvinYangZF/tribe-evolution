const { chromium } = require("playwright");
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  await page.goto("https://yzftest.cpolar.top/login.html", { waitUntil: "networkidle", timeout: 15000 });
  console.log("1. Login page:", (await page.title()) || "FAILED");
  
  await page.fill("#pwd", "1125664768");
  await page.click("#btn");
  await page.waitForTimeout(4000);
  
  console.log("2. Dashboard:", (await page.title()) || "FAILED");
  console.log("3. Agents:", await page.textContent("#agent-count").catch(() => "ERROR"));
  console.log("4. Status:", await page.textContent("#status-text").catch(() => "ERROR"));
  
  await browser.close();
})();
