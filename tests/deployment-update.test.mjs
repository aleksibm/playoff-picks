import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const installed='a'.repeat(40),available='b'.repeat(40);
const linux={skip:process.platform!=='linux'?'The updater uses Linux shell commands and systemd.':false};

function fixture(t,{marker=true}={}){
  const directory=mkdtempSync(join(tmpdir(),'playoff-update-test-'));
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const app=join(directory,'app'),bin=join(directory,'bin'),trace=join(directory,'trace');
  mkdirSync(join(app,'deployment'),{recursive:true});mkdirSync(bin);
  if(marker)writeFileSync(join(app,'deployment/release.txt'),installed+'\n');
  const stub=(name,source)=>writeFileSync(join(bin,name),'#!/bin/sh\nset -eu\n'+source,{mode:0o755});
  stub('id',"printf '0\\n'\n");
  stub('git',`printf 'git %s\\n' "$1" >> "$TEST_TRACE"
case "$1" in
    ls-remote)
        test "$GIT_TERMINAL_PROMPT" = 0
        test "$GH_PROMPT_DISABLED" = 1
        if [ "$TEST_REMOTE_FAIL" = 1 ]; then exit 128; fi
        printf '%s\\trefs/heads/main\\n' "$TEST_REMOTE_SHA"
        ;;
    clone)
        for task_argument do task_destination=$task_argument; done
        mkdir -p "$task_destination"
        ;;
    rev-parse) printf '%s\\n' "$TEST_CLONED_SHA" ;;
    *) exit 90 ;;
esac
`);
  // Stop at validation so a changed commit cannot touch an actual installation.
  stub('node',"printf 'node %s\\n' \"$1\" >> \"$TEST_TRACE\"\nexit 23\n");
  stub('systemctl',"printf 'systemctl %s\\n' \"$1\" >> \"$TEST_TRACE\"\nexit 91\n");
  const source=readFileSync(new URL('../deployment/update.sh',import.meta.url),'utf8')
    .replaceAll('/opt/playoff-picks',app)
    .replaceAll('/run/lock/playoff-picks-update.lock',join(directory,'update.lock'))
    .replaceAll('/tmp/playoff-picks-update-XXXXXX',join(directory,'checkout-XXXXXX'))
    .replaceAll('/tmp/playoff-picks-updater-XXXXXX',join(directory,'script-XXXXXX'))
    .replaceAll('/etc/systemd/system',join(directory,'units'))
    .replaceAll('/usr/bin/node',join(bin,'node'));
  const script=join(directory,'update.sh');writeFileSync(script,source);
  return {
    directory,app,
    run:(extra={},args=['--if-new'])=>spawnSync('/bin/sh',[script,...args],{
      env:{...process.env,PATH:`${bin}:${process.env.PATH}`,TEST_TRACE:trace,TEST_REMOTE_FAIL:'0',TEST_REMOTE_SHA:available,TEST_CLONED_SHA:available,...extra},
      encoding:'utf8',timeout:5000,
    }),
    trace:()=>{try{return readFileSync(trace,'utf8').trim().split('\n');}catch{return [];}},
  };
}

test('a weekly check of an unchanged commit never clones, tests, backs up or restarts the app',linux,t=>{
  const f=fixture(t),result=f.run({TEST_REMOTE_SHA:installed});
  assert.equal(result.status,0,result.stderr);
  assert.match(result.stdout,/No GitHub update is available/);
  assert.deepEqual(f.trace(),['git ls-remote']);
  assert.equal(readdirSync(f.directory).some(name=>name.startsWith('checkout-')),false);
  assert.equal(readFileSync(join(f.app,'deployment/release.txt'),'utf8'),installed+'\n');
});

test('a changed GitHub commit enters validation before touching the running installation',linux,t=>{
  const f=fixture(t),result=f.run();
  assert.equal(result.status,23,result.stderr);
  assert.deepEqual(f.trace(),['git ls-remote','git clone','git rev-parse','node --test']);
  assert.equal(readFileSync(join(f.app,'deployment/release.txt'),'utf8'),installed+'\n');
});

test('an unavailable GitHub feed fails the check without deploying or stopping the app',linux,t=>{
  const f=fixture(t),result=f.run({TEST_REMOTE_FAIL:'1'});
  assert.equal(result.status,128,result.stderr);
  assert.deepEqual(f.trace(),['git ls-remote']);
});

test('a malformed advertised commit cannot trigger an unattended deployment',linux,t=>{
  const f=fixture(t),result=f.run({TEST_REMOTE_SHA:'unexpected-response'});
  assert.equal(result.status,1,result.stderr);
  assert.deepEqual(f.trace(),['git ls-remote']);
});

test('main returning to the installed commit during cloning avoids a redundant restart',linux,t=>{
  const f=fixture(t),result=f.run({TEST_CLONED_SHA:installed});
  assert.equal(result.status,0,result.stderr);
  assert.deepEqual(f.trace(),['git ls-remote','git clone','git rev-parse']);
});

test('an installation without a release marker must validate an update instead of assuming it is current',linux,t=>{
  const f=fixture(t,{marker:false}),result=f.run({TEST_REMOTE_SHA:installed,TEST_CLONED_SHA:installed});
  assert.equal(result.status,23,result.stderr);
  assert.deepEqual(f.trace(),['git ls-remote','git clone','git rev-parse','node --test']);
});

test('an explicitly pinned update still rejects a different GitHub commit before validation',linux,t=>{
  const f=fixture(t),result=f.run({},[installed]);
  assert.equal(result.status,1,result.stderr);
  assert.deepEqual(f.trace(),['git clone','git rev-parse']);
  assert.match(result.stderr,/GitHub main changed/);
});
