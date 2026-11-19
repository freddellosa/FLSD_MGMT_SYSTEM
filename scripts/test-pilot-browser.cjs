const {spawnSync}=require('node:child_process');
const result=spawnSync(process.execPath,['node_modules/@playwright/test/cli.js','test','tests/e2e/pilot.spec.ts'],{env:{...process.env,FLSD_PILOT_E2E:'1',FLSD_E2E_PORT:'3001'},stdio:'inherit',windowsHide:true});
process.exitCode=result.status??1;
