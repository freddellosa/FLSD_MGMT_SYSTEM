import {test,expect} from '@playwright/test';

// All API responses are stubbed: no account lockouts or database writes.
for(const scenario of [
 {status:401,message:'Invalid email or password'},
 {status:429,message:'Too many attempts. Try again in 15 minutes.'},
])test('pilot sign-in preserves the server explanation for '+scenario.status,async({page})=>{
 await page.route('**/api/pilot/workspace',route=>route.fulfill({status:401,contentType:'application/json',body:JSON.stringify({error:'Sign in required'})}));
 await page.route('**/api/pilot/login',route=>route.fulfill({status:scenario.status,contentType:'application/json',body:JSON.stringify({error:scenario.message})}));
 await page.goto('/pilot');
 await expect(page.getByLabel('Pilot email')).toBeVisible();
 await expect(page.getByRole('main').getByRole('alert')).toHaveCount(0);
 await page.getByLabel('Pilot email').fill('qa-error@example.test');
 await page.getByLabel('Pilot password').fill('Fictional test password');
 await page.getByRole('button',{name:'Sign in',exact:true}).click();
 await expect(page.getByRole('main').getByRole('alert')).toHaveText(scenario.message);
 await expect(page.getByLabel('Pilot email')).toHaveValue('qa-error@example.test');
 await expect(page.getByLabel('Pilot password')).toHaveValue('Fictional test password');
 await expect(page.getByRole('button',{name:'Sign in',exact:true})).toBeEnabled();
 await expect(page.getByText(/Sign in with the credentials issued for your pilot account/)).toBeVisible();
 await expect(page.getByText(/bootstrap\.json|\.pilot-owner-access/)).toHaveCount(0);
});
