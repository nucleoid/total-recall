import assert from 'node:assert/strict';
import test from 'node:test';
import{mkdtemp,writeFile,rm}from'node:fs/promises';
import{homedir}from'node:os';
import{join,resolve,sep}from'node:path';
import{execFile}from'node:child_process';
import{promisify}from'node:util';
import{verifyWindowsEmbeddingPermissions,protectNewWindowsEmbeddingDirectory}from'../src/windows-embedding-permissions.js';

test('Windows runtime write access and secret read access fail closed',{skip:process.platform!=='win32'},async()=>{
  const base=resolve(homedir()),directory=await mkdtemp(join(base,'.total-recall-acl-test-')),file=join(directory,'synthetic.txt');
  try{
    await protectNewWindowsEmbeddingDirectory(directory);
    await writeFile(file,'public synthetic permission fixture');
    await verifyWindowsEmbeddingPermissions([file],true);
    await promisify(execFile)('icacls.exe',[file,'/grant','*S-1-1-0:(R)'],{windowsHide:true,timeout:5000});
    await verifyWindowsEmbeddingPermissions([file]);
    await assert.rejects(verifyWindowsEmbeddingPermissions([file],true),/windows_permissions/);
    await promisify(execFile)('icacls.exe',[file,'/grant','*S-1-1-0:(M)'],{windowsHide:true,timeout:5000});
    await assert.rejects(verifyWindowsEmbeddingPermissions([file]),/windows_permissions/);
  }finally{
    assert.ok(resolve(directory).startsWith(base+sep));
    await rm(directory,{recursive:true,force:true});
  }
});

test('Windows null DACL and raw GENERIC_ALL grants are rejected',{skip:process.platform!=='win32'},async()=>{
  const base=resolve(homedir()),directory=await mkdtemp(join(base,'.total-recall-acl-test-')),file=join(directory,'synthetic.txt');
  try{
    await protectNewWindowsEmbeddingDirectory(directory);await writeFile(file,'public synthetic ACL fixture');
    for(const sddl of ['D:NO_ACCESS_CONTROL','D:(A;;GA;;;WD)']){
      const path64=Buffer.from(file).toString('base64');
      const script=`$ErrorActionPreference='Stop';$path=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${path64}'));$acl=[IO.File]::GetAccessControl($path);$acl.SetSecurityDescriptorSddlForm('${sddl}',[Security.AccessControl.AccessControlSections]::Access);[IO.File]::SetAccessControl($path,$acl)`;
      await promisify(execFile)('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,timeout:5000});
      await assert.rejects(verifyWindowsEmbeddingPermissions([file]),/windows_permissions/);
    }
  }finally{assert.ok(resolve(directory).startsWith(base+sep));await rm(directory,{recursive:true,force:true});}
});
