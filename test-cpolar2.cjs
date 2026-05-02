const { chromium } = require("playwright");
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto("http://localhost:3001/login.html", { waitUntil: "networkidle" });
  await page.fill("#pwd", "1125664768");
  await page.click("#btn");
  await page.waitForTimeout(3000);
  console.log("Agents:", await page.textContent("#agent-count").catch(()=>"ERR"));
  console.log("Status:", await page.textContent("#status-text").catch(()=>"ERR"));
  await browser.close();
})();
