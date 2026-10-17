import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createAccountStore } from '../accounts.mjs';
import { createApp } from '../server.mjs';
import { TEAMS, DIVISIONS } from '../dist/game.js';

const PASSWORD = 'Original-Test-Password-2026';
const PICKS = DIVISIONS.flatMap(division => TEAMS.filter(team => team.division === division.id).slice(0,4).map(team => team.id));
function storeFor(t) {
  const store = createAccountStore(':memory:');
  t.after(() => store.close());
  return store;
}

test('admin rename updates login and leaderboard names while preserving picks and sessions', async t => {
  const store = storeFor(t);
  const fan = await store.register('OriginalFan', PASSWORD);
  const prediction = store.submitPrediction(fan.user.id, PICKS, 0);
  store.adminRenameUser(fan.user.id, 'NewFan', fan.user.username);
  assert.equal(store.getSession(fan.token).user.displayName, 'NewFan');
  assert.equal((await store.login('NEWFAN', PASSWORD)).user.id, fan.user.id);
  await assert.rejects(store.login('OriginalFan', PASSWORD), {status:401});
  assert.equal(store.listSubmitted()[0].username, 'newfan');
  assert.deepEqual(store.getPrediction(fan.user.id), prediction);
});

test('admin rejects duplicate, invalid, missing, and stale account names without changing accounts', async t => {
  const store = storeFor(t);
  const fan = await store.register('FirstFan', PASSWORD);
  await store.register('SecondFan', PASSWORD);
  assert.throws(() => store.adminRenameUser(fan.user.id, 'SECONDFAN', 'firstfan'), {status:409});
  assert.throws(() => store.adminRenameUser(fan.user.id, '<script>', 'firstfan'), {status:400});
  assert.throws(() => store.adminRenameUser(fan.user.id, 'NewFan', 'changedfan'), {status:409});
  assert.throws(() => store.adminRenameUser(999, 'NewFan', 'firstfan'), {status:404});
  assert.equal(store.getSession(fan.token).user.username, 'firstfan');
});

test('admin password reset revokes all target sessions and preserves other accounts and predictions', async t => {
  const store = storeFor(t);
  const fan = await store.register('ResetFan', PASSWORD);
  const secondSession = await store.login('ResetFan', PASSWORD);
  const other = await store.register('OtherFan', PASSWORD);
  const prediction = store.submitPrediction(fan.user.id, PICKS, 0);
  await store.adminResetPassword(fan.user.id, 'seven77', fan.user.username);
  assert.equal(store.getSession(fan.token), null);
  assert.equal(store.getSession(secondSession.token), null);
  assert.equal(store.getSession(other.token).user.id, other.user.id);
  await assert.rejects(store.login('ResetFan', PASSWORD), {status:401});
  assert.equal((await store.login('ResetFan', 'seven77')).user.id, fan.user.id);
  assert.deepEqual(store.getPrediction(fan.user.id), prediction);
  assert.doesNotMatch(JSON.stringify(store.listAccounts()), /seven77|password_hash|password_salt/);
});

test('invalid or stale password resets preserve the existing credentials and sessions', async t => {
  const store = storeFor(t);
  const fan = await store.register('ResetFan', PASSWORD);
  for (const password of ['sixsix', 'a'.repeat(129), null, 7]) {
    await assert.rejects(store.adminResetPassword(fan.user.id, password, fan.user.username), {status:400});
  }
  await assert.rejects(store.adminResetPassword(fan.user.id, 'seven77', 'stale_name'), {status:409});
  assert.ok(store.getSession(fan.token));
  assert.equal((await store.login('ResetFan', PASSWORD)).user.id, fan.user.id);
});

test('admin selection reset unlocks a submitted prediction with a new revision and blocks stale writes', async t => {
  const store = storeFor(t);
  const fan = await store.register('LockedFan', PASSWORD);
  const old = store.submitPrediction(fan.user.id, PICKS, 0);
  const reset = store.adminResetPrediction(fan.user.id, old.revision, fan.user.username);
  assert.equal(reset.state, 'draft');
  assert.equal(reset.submittedAt, null);
  assert.deepEqual(reset.teamIds, []);
  assert.equal(reset.revision, old.revision + 1);
  assert.deepEqual(store.listSubmitted(), []);
  assert.ok(store.getSession(fan.token));
  assert.throws(() => store.saveDraft(fan.user.id, PICKS, old.revision), {status:409});
  assert.throws(() => store.adminResetPrediction(fan.user.id, old.revision, fan.user.username), {status:409});
  assert.equal(store.submitPrediction(fan.user.id, PICKS, reset.revision).state, 'submitted');
});

test('admin reset clears drafts, leaves other players intact, and validates the reviewed revision', async t => {
  const store = storeFor(t);
  const fan = await store.register('DraftFan', PASSWORD);
  const other = await store.register('OtherFan', PASSWORD);
  const otherPrediction = store.submitPrediction(other.user.id, PICKS, 0);
  const draft = store.saveDraft(fan.user.id, ['BOS'], 0);
  for (const revision of [undefined, null, -1, '1', 1.5]) {
    assert.throws(() => store.adminResetPrediction(fan.user.id, revision, fan.user.username), {status:400});
  }
  assert.throws(() => store.adminResetPrediction(fan.user.id, draft.revision, 'changed_name'), {status:409});
  assert.deepEqual(store.adminResetPrediction(fan.user.id, draft.revision, fan.user.username).teamIds, []);
  assert.deepEqual(store.getPrediction(other.user.id), otherPrediction);
});

function request(url, path, {method='GET',body,headers={}} = {}) {
  return new Promise((resolve,reject) => {
    const outgoing = http.request(new URL(path,url), {method,headers,agent:false}, response => {
      const chunks=[];
      response.on('data',chunk=>chunks.push(chunk));
      response.on('end',()=>resolve({status:response.statusCode,headers:response.headers,
        data:JSON.parse(Buffer.concat(chunks).toString('utf8'))}));
    });
    outgoing.on('error',reject);
    outgoing.end(body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body));
  });
}
async function httpFor(t) {
  const app = createApp({dbPath:':memory:',allowStandingsFetch:false,publicOrigin:null});
  t.after(()=>app.close());
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  const playerUrl=`http://127.0.0.1:${app.server.address().port}`;
  const adminUrl=new URL(await app.startAdmin(0)).origin;
  const register = await request(playerUrl,'/api/register',{method:'POST',body:{username:'ManageFan',password:PASSWORD},
    headers:{Origin:playerUrl,'Content-Type':'application/json'}});
  const cookie=register.headers['set-cookie'][0].split(';')[0];
  const overview=(await request(adminUrl,'/api/admin/overview')).data;
  const id=register.data.user.id;
  const action=(name,body,headers={})=>request(adminUrl,`/api/admin/accounts/${id}/${name}`,{method:'POST',body,
    headers:{Origin:adminUrl,'Content-Type':'application/json','X-CSRF-Token':overview.csrfToken,...headers}});
  return {app,playerUrl,adminUrl,id,cookie,overview,register,action};
}

test('local admin HTTP actions rename, reset passwords, and clear locked picks without exposing secrets', async t => {
  const c=await httpFor(t);
  const renamed=await c.action('rename',{username:'RenamedFan',expectedUsername:'managefan'});
  assert.equal(renamed.status,200);
  assert.equal(renamed.data.accounts[0].displayName,'RenamedFan');
  const resetPassword=await c.action('password',{password:'seven77',expectedUsername:'renamedfan'});
  assert.equal(resetPassword.status,200);
  assert.doesNotMatch(JSON.stringify(resetPassword.data),/seven77|password_hash|password_salt/);
  assert.equal((await request(c.playerUrl,'/api/session',{headers:{Cookie:c.cookie}})).data.user,null);
  const login=await request(c.playerUrl,'/api/login',{method:'POST',body:{username:'RenamedFan',password:'seven77'},headers:{Origin:c.playerUrl,'Content-Type':'application/json'}});
  assert.equal(login.status,200);
  const cookie=login.headers['set-cookie'][0].split(';')[0];
  const headers={Origin:c.playerUrl,'Content-Type':'application/json','X-CSRF-Token':login.data.csrfToken,Cookie:cookie};
  const submitted=await request(c.playerUrl,'/api/prediction/submit',{method:'POST',headers,body:{teamIds:PICKS,revision:0}});
  assert.equal(submitted.status,200);
  const reset=await c.action('reset-prediction',{revision:1,expectedUsername:'renamedfan'});
  assert.equal(reset.status,200);
  assert.equal(reset.data.summary.submitted,0);
  assert.deepEqual(reset.data.accounts[0].prediction.teamIds,[]);
  assert.equal(reset.data.accounts[0].prediction.revision,2);
  assert.equal((await request(c.playerUrl,'/api/leaderboard',{headers:{Cookie:cookie}})).data.locked,true);
  assert.equal((await request(c.playerUrl,'/api/prediction',{method:'PUT',headers,body:{teamIds:PICKS,revision:1}})).status,409);
});

test('admin account writes reject cross-site, forged, proxy, missing-Origin and player-CSRF requests', async t => {
  const c=await httpFor(t);
  for (const name of ['rename','password','reset-prediction']) {
    const body=name==='rename'?{username:'NewFan',expectedUsername:'managefan'}:name==='password'?{password:'seven77',expectedUsername:'managefan'}:{revision:0,expectedUsername:'managefan'};
    for (const headers of [{Origin:''},{Origin:c.playerUrl},{Origin:'https://evil.example'},{'X-CSRF-Token':''},
      {'X-CSRF-Token':c.register.data.csrfToken},{'Sec-Fetch-Site':'cross-site'},{'X-Forwarded-For':'127.0.0.1'},
      {'CF-Connecting-IP':'127.0.0.1'},{Host:'evil.example'}]) {
      assert.equal((await c.action(name,body,headers)).status,403,`${name} ${JSON.stringify(headers)}`);
    }
    assert.equal((await request(c.adminUrl,`/api/admin/accounts/${c.id}/${name}`,{method:'POST',body,
      headers:{'Content-Type':'application/json','X-CSRF-Token':c.overview.csrfToken}})).status,403);
    for (const method of ['GET','POST']) assert.equal((await request(c.playerUrl,`/api/admin/accounts/${c.id}/${name}`,{method,body:method==='POST'?body:undefined,
      headers:method==='POST'?{Origin:c.playerUrl,'Content-Type':'application/json'}:{}})).status,404);
  }
  assert.equal((await request(c.adminUrl,'/api/admin/overview')).data.accounts[0].username,'managefan');
});

test('admin account writes validate method, JSON size, action fields, account identity, and stale revisions', async t => {
  const c=await httpFor(t);
  assert.equal((await request(c.adminUrl,`/api/admin/accounts/${c.id}/rename`)).status,405);
  assert.equal((await c.action('rename',{}, {'Content-Type':'text/plain'})).status,415);
  for (const body of ['{bad','null','[]','{}','{"username":"NewFan","expectedUsername":"managefan","id":99}']) {
    assert.equal((await c.action('rename',body)).status,400);
  }
  assert.equal((await c.action('password',{password:'x'.repeat(5000),expectedUsername:'managefan'})).status,413);
  assert.equal((await c.action('password',{password:'short',expectedUsername:'managefan'})).status,400);
  assert.equal((await c.action('rename',{username:'NewFan',expectedUsername:'stale'})).status,409);
  assert.equal((await c.action('reset-prediction',{revision:1,expectedUsername:'managefan'})).status,409);
});
