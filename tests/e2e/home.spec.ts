import { test, expect } from "@playwright/test";
test("shows foundation overview", async ({ page }) => {
 await page.goto("/");
 await expect(page.getByRole("heading", { name: "Management overview" })).toBeVisible();
 await expect(page.getByText("Foundation preview")).toBeVisible();
});

test('responsive owner overview preserves vertical charts, customer shares and operational KPIs',async({page})=>{
 await page.clock.setFixedTime(new Date('2026-11-15T04:00:00Z'));
 await page.setViewportSize({width:1366,height:768});await page.goto('/');await page.getByLabel('Demo role').selectOption('OWNER');
 await expect(page.getByRole('heading',{name:'Trips in motion',exact:true})).toHaveCount(0);
 await expect(page.getByRole('heading',{name:'Beyond the collection total',exact:true})).toHaveCount(0);
 await expect(page.getByRole('heading',{name:'Keep the day moving.',exact:true})).toBeVisible();
 const current=page.getByRole('img',{name:/Customer revenue share - 2026/}),previous=page.getByRole('img',{name:/Customer revenue share - 2025/});
 await expect(current).toHaveAttribute('aria-label',/Northstar Logistics, 44.44%, ₱40,000.00/);
 await expect(current).toHaveAttribute('aria-label',/Santos Family, 24.44%, ₱22,000.00/);
 await expect(previous).toHaveAttribute('aria-label',/No revenue/);
 const monthly=page.getByRole('img',{name:/Monthly revenue - 2026/});
 expect((await monthly.boundingBox())!.height).toBeLessThanOrEqual(115);
 const november=monthly.locator('.vertical-bar-column').nth(10).locator('.vertical-bar-track > div');
 expect((await november.boundingBox())!.height).toBeGreaterThan(50);
 const dimensions=await page.evaluate(()=>({height:document.documentElement.scrollHeight,width:document.documentElement.scrollWidth,viewportHeight:innerHeight,viewportWidth:innerWidth}));
 expect(dimensions.width).toBeLessThanOrEqual(dimensions.viewportWidth);
 await expect(page.getByRole('button',{name:'Reset sample data',exact:true})).toBeInViewport();await expect(page.getByRole('button',{name:/Direct-pay trips/})).toBeVisible();
 await expect(page.getByRole('navigation').getByRole('button',{name:'Settings',exact:true})).toBeInViewport({ratio:1});
 // A customer present in both years retains its color even when year membership differs.
 await page.getByRole('navigation').getByRole('button',{name:'Trips',exact:true}).click();await page.getByRole('button',{name:'New trip',exact:true}).click();const modal=page.getByRole('dialog');
 await modal.getByRole('combobox',{name:'Charge to / customer',exact:true}).selectOption('c3');
 await modal.getByLabel('Destination details / stops',{exact:true}).fill('Previous-year customer share check');await modal.getByLabel('Base amount (PHP)',{exact:true}).fill('100');
 await modal.getByLabel('Trip date (start)',{exact:true}).fill('2025-06-01');await modal.getByLabel('Trip end date',{exact:true}).fill('2025-06-01');await modal.getByRole('button',{name:'Create demo trip',exact:true}).click();
 await page.getByRole('navigation').getByRole('button',{name:'Dashboard',exact:true}).click();await expect(previous).toHaveAttribute('aria-label',/Marisol Events, 100.00%, ₱100.00/);
 const color=(chart:typeof current)=>chart.locator('..').locator('.pie-legend > div').filter({hasText:'Marisol Events'}).locator('i').evaluate(node=>getComputedStyle(node).backgroundColor);
 expect(await color(current)).toBe(await color(previous));
 await page.setViewportSize({width:390,height:844});
 expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
 await expect(current).toBeVisible();
 await page.getByLabel('Demo role').selectOption('BILLING');await expect(page.getByRole('img',{name:/Customer revenue share/})).toHaveCount(0);
});
