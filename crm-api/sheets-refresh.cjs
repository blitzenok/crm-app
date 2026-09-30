#!/usr/bin/env node
// Auto-refresh Google Sheets OAuth access token for Blitz CRM dashboard.
// Reads /opt/crm-api/sheets-oauth.env, writes a fresh access token to /opt/crm-api/sheets-token.env.
const fs = require('fs');
const https = require('https');
const OAUTH_ENV = '/opt/crm-api/sheets-oauth.env';
const OUT_ENV = '/opt/crm-api/sheets-token.env';
function parseEnv(p){const o={};for(const l of fs.readFileSync(p,'utf8').split(/\r?\n/)){if(l.trim().startsWith('#'))continue;const m=l.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);if(m)o[m[1]]=m[2].trim();}return o;}
let c;try{c=parseEnv(OAUTH_ENV);}catch(e){console.error('cannot read',OAUTH_ENV,e.message);process.exit(1);}
const id=c.GOOGLE_CLIENT_ID,sec=c.GOOGLE_CLIENT_SECRET,rt=c.GOOGLE_REFRESH_TOKEN;
if(!id||!sec||!rt){console.error('missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN in',OAUTH_ENV);process.exit(1);}
const body=new URLSearchParams({client_id:id,client_secret:sec,refresh_token:rt,grant_type:'refresh_token'}).toString();
const req=https.request({hostname:'oauth2.googleapis.com',path:'/token',method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','Content-Length':Buffer.byteLength(body)}},res=>{
  let d='';res.on('data',x=>d+=x);res.on('end',()=>{
    let j;try{j=JSON.parse(d);}catch(e){console.error('bad response',res.statusCode,d.slice(0,200));process.exit(1);}
    if(res.statusCode!==200||!j.access_token){console.error('refresh FAILED',res.statusCode,j.error||'',j.error_description||'');process.exit(1);}
    const now=new Date().toISOString().replace('T',' ').replace(/\.\d+Z$/,' UTC');
    fs.writeFileSync(OUT_ENV,'SHEETS_TOKEN='+j.access_token+'\nGOOGLESHEETS_ACCESS_TOKEN='+j.access_token+'\nSHEETS_TOKEN_UPDATED='+now+'\n',{mode:0o600});
    console.log('OK: fresh token written, expires_in',j.expires_in,'s,',now);
  });
});
req.on('error',e=>{console.error('request error',e.message);process.exit(1);});
req.write(body);req.end();
