const { chromium } = require("playwright");
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  await page.goto("http://localhost:3001/login.html", { waitUntil: "networkidle" });
  console.log("1. Login:", await page.title());
  
  await page.fill("#pwd", "1125664768");
  await page.click("#btn");
  await page.waitForTimeout(3000);
  
  console.log("2. Dashboard:", await page.title());
  console.log("3. Agents:", await page.textContent("#agent-count"));
  console.log("4. Status:", await page.textContent("#status-text"));
  console.log("5. Pop:", await page.textContent("#footer-pop"));
  console.log("6. Fitness:", await page.textContent("#footer-fitness"));
  console.log("7. Gen:", await page.textContent("#footer-gen"));
  console.log("8. Charts:", await page.$$eval("canvas", els => els.length));
  console.log("9. Tree SVG:", (await page.$("#tree-svg")) ? "YES" : "NO");
  
  await page.screenshot({ path: "test-dashboard.png", fullPage: false });
  console.log("10. Screenshot saved");
  await browser.close();
})();
