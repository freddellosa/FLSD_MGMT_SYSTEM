// Explicit Owner-approved patch download; no credentials or install scripts.
const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
try{
 if(root!=='D:\\FLSD-Batch7-Validation'||!process.argv.includes('--approved'))throw Error('Explicit workspace patch approval required');
 if(fs.existsSync(path.join(root,'.npmrc')))throw Error('Project registry configuration present; stopped without reading it');
 const lock=JSON.parse(fs.readFileSync(path.join(root,'package-lock.json'),'utf8'));
 for(const item of Object.values(lock.packages??{}))if(item.resolved){const u=new URL(item.resolved);if(u.protocol!=='https:'||u.hostname!=='registry.npmjs.org'||u.username||u.password)throw Error('Public-registry-only lockfile required');}
 const stamp=new Date().toISOString().replace(/[^0-9]/g,''),backup=path.join(root,'.pilot/dependency-backups',stamp);fs.mkdirSync(backup,{recursive:true});
 for(const name of ['package.json','package-lock.json'])fs.copyFileSync(path.join(root,name),path.join(backup,name));
 const userConfig=path.join(backup,'npm-public-user.ini'),globalConfig=path.join(backup,'npm-public-global.ini');
 fs.writeFileSync(userConfig,'registry=https://registry.npmjs.org/\nignore-scripts=true\naudit=false\nfund=false\n');fs.writeFileSync(globalConfig,'');
 const allowed=['SYSTEMROOT','WINDIR','PATH','PATHEXT','TEMP','TMP','COMSPEC','USERPROFILE','LOCALAPPDATA','APPDATA','PROCESSOR_ARCHITECTURE','NUMBER_OF_PROCESSORS'];
 const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>allowed.includes(key.toUpperCase())));
 // Retain an externally imposed offline setting; do not override it.
 if(process.env.npm_config_offline==='true')env.npm_config_offline='true';
 const cli=path.join(path.dirname(process.execPath),'node_modules/npm/bin/npm-cli.js');if(!fs.existsSync(cli))throw Error('Installed npm CLI required');
 console.log('Applying approved patch set from public npm only; private configurations excluded. Manifest backup: '+path.relative(root,backup));
 const result=spawnSync(process.execPath,[cli,'install','--save-exact','next@15.5.29','eslint-config-next@15.5.29','react@19.1.10','react-dom@19.1.10','--ignore-scripts','--no-audit','--no-fund','--registry=https://registry.npmjs.org/','--cache='+path.join(root,'.npm-pilot-cache'),'--userconfig='+userConfig,'--globalconfig='+globalConfig,'--fetch-retries=0','--fetch-timeout=30000'],{cwd:root,env,windowsHide:true,stdio:'inherit',timeout:180000});
 if(result.status!==0){console.error('Security patch installation did not complete. Do not assume dependencies changed or bypass network restrictions. Inspect saved manifests and installed versions before recovery.');process.exitCode=1;}
 else console.log('Approved patch installation completed; build, package versions and regressions still require verification.');
}catch{console.error('Workspace security update stopped; no private configuration or credentials logged.');process.exitCode=1;}
