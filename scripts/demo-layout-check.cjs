/** Optional local visual check; uses installed Edge and a running localhost demo. */
const { chromium } = require('playwright');
(async()=>{
 const browser=await chromium.launch({channel:'msedge',headless:true});
 try {
  const page=await browser.newPage({viewport:{width:1440,height:1100}});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  const response=await page.goto('http://127.0.0.1:3000');
  await page.getByRole('heading',{name:'Management overview'}).waitFor();
  await page.screenshot({path:'docs/demo-preview-desktop.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});
  await page.getByRole('button',{name:'Toggle navigation'}).click();
  await page.getByRole('navigation').getByRole('button',{name:'Trips',exact:true}).click();
  await page.getByRole('heading',{name:'Trip management'}).waitFor();
  // Wait for the sidebar's finite CSS transition before capturing the mobile view.
  await page.locator('.sidebar').evaluate(el=>Promise.all(el.getAnimations().map(animation=>animation.finished)));
  await page.screenshot({path:'docs/demo-preview-mobile.png',fullPage:true});
  const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);
  console.log(JSON.stringify({status:response.status(),mobileOverflow:overflow,browserErrors:errors,screenshots:['docs/demo-preview-desktop.png','docs/demo-preview-mobile.png']}));
  if(overflow||errors.length)process.exitCode=1;
 } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
