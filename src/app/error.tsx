'use client';
export default function ErrorPage({reset}:{reset:()=>void}){return <main style={{maxWidth:560,margin:'12vh auto',padding:30}}><h1>Unable to open the workspace</h1><p>The page could not finish loading. Retry to reopen the demonstration.</p><button className="button" onClick={reset}>Retry workspace</button><p>Refreshing restores the fictional demo records.</p></main>;}
