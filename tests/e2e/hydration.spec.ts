import {test,expect} from '@playwright/test';
test('demo role changes wait for hydration instead of reverting under slow script loading',async({page})=>{
 await page.route('**/_next/static/**/*.js',async route=>{await new Promise(resolve=>setTimeout(resolve,1500));await route.continue();});
 await page.goto('/',{waitUntil:'commit'});const role=page.getByLabel('Demo role');await expect(role).toBeDisabled();await expect(role).toBeEnabled();await role.selectOption('ADMIN');
 await page.getByRole('navigation',{name:'Main navigation'}).getByRole('button',{name:'Customers',exact:true}).click();await expect(role).toHaveValue('ADMIN');await expect(page.getByRole('button',{name:'Edit customer Northstar Logistics',exact:true})).toBeVisible();
});
