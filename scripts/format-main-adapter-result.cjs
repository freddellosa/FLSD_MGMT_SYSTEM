const {safeReport}=require('./lib/main-adapter-diagnostics.cjs');
(async()=>{try{
 const chunks=[];let size=0;for await(const chunk of process.stdin){size+=chunk.length;if(size>4*1024*1024)throw new Error();chunks.push(chunk);}
 const input=JSON.parse(Buffer.concat(chunks).toString('utf8').replace(/^\ufeff/,''));
 process.stdout.write(JSON.stringify(safeReport(input))+'\n');
}catch{process.stdout.write(JSON.stringify({kind:'SANITIZED_MAIN_ADAPTER_RESULT',category:'UNKNOWN_FAILURE',rawOutputIncluded:false})+'\n');process.exitCode=1;}})();
