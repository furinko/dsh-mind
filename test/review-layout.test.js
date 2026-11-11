import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {reviewScene} from './review-experiment-fixture.mjs';
import {copyExperimentCandidate,verifyExperimentCopy,removeExperimentScope,experimentEnvironment} from '../src/review-experiment-files.js';

test('review temp, home and executables are owned siblings outside the source copy',()=>reviewScene(async s=>{
  const scope=copyExperimentCandidate(s.config.candidates[0],s.config);
  try{
    for(const file of [scope.temp,scope.home,scope.nodePath]){
      assert.equal(path.relative(scope.workspace,file).startsWith('..'),true);
      assert.equal(path.relative(scope.root,file).startsWith('..'),false);
    }
    const env=experimentEnvironment(scope);
    assert.equal(env.HOME,scope.home);assert.equal(env.USERPROFILE,scope.home);
    assert.equal(env.TEMP,scope.temp);assert.equal(env.TMPDIR,scope.temp);
    assert.notEqual(env.HOME,process.env.HOME);
    verifyExperimentCopy(scope,s.config.candidates[0],s.config);
    fs.writeFileSync(path.join(scope.temp,'unexpected'),'x');
    assert.throws(()=>verifyExperimentCopy(scope,s.config.candidates[0],s.config),/临时目录/);
  }finally{removeExperimentScope(scope);}
}));
