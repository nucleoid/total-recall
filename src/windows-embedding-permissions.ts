import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {realpath} from 'node:fs/promises';
import {homedir} from 'node:os';
import {dirname,relative,isAbsolute,sep} from 'node:path';

/** Call only for a freshly created owned secret directory, before writing keys. */
export async function protectNewWindowsEmbeddingDirectory(path:string):Promise<void>{
  if(process.platform!=='win32')return;
  const canonical=await realpath(path),home=await realpath(homedir()),rel=relative(home,canonical);
  if(!rel||isAbsolute(rel)||rel==='..'||rel.startsWith('..'+sep))throw new Error('gateway.windows_profile_confinement');
  const data=Buffer.from(canonical).toString('base64');
  const program=`$ErrorActionPreference='Stop'
$path=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${data}'))
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
$existing=[IO.Directory]::GetAccessControl($path)
if($existing.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin @($sid.Value,'S-1-5-18','S-1-5-32-544')){throw 'owner'}
$acl=[Security.AccessControl.DirectorySecurity]::new()
$acl.SetOwner($sid);$acl.SetAccessRuleProtection($true,$false)
foreach($id in @($sid.Value,'S-1-5-18','S-1-5-32-544')){
 $rule=[Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($id),[Security.AccessControl.FileSystemRights]::FullControl,[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit',[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow)
 $acl.AddAccessRule($rule)
}
[IO.Directory]::SetAccessControl($path,$acl)
@{ok=$true}|ConvertTo-Json -Compress`;
  try{const result=await promisify(execFile)('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(program,'utf16le').toString('base64')],{timeout:10_000,maxBuffer:4096,windowsHide:true});
    if(JSON.parse(result.stdout).ok!==true)throw new Error('acl');
  }catch{throw new Error('gateway.windows_permissions');}
}

/** Windows embedding installs are confined to the current user's profile.
 * Public artifacts may be readable, but only the owner/SYSTEM/Administrators may
 * modify any component down from that protected profile boundary. */
export async function verifyWindowsEmbeddingPermissions(paths:string[],sensitive=false):Promise<void>{
  if(process.platform!=='win32')return;
  const home=await realpath(homedir()),checked=new Set<string>();
  const privateFiles=new Set<string>();
  for(const path of paths){
    const canonical=await realpath(path),rel=relative(home,canonical);
    if(isAbsolute(rel)||rel==='..'||rel.startsWith('..'+sep))throw new Error('gateway.windows_profile_confinement');
    if(sensitive)privateFiles.add(canonical.toLowerCase());
    let current=canonical;
    while(!checked.has(current)){checked.add(current);if(current.toLowerCase()===home.toLowerCase())break;current=dirname(current);}
  }
  const entries=[...checked].map(path=>({path,sensitive:privateFiles.has(path.toLowerCase())}));
  for(let offset=0;offset<entries.length;offset+=10){
    // Only base64 data is interpolated. Filenames never become PowerShell code.
    const data=Buffer.from(JSON.stringify(entries.slice(offset,offset+10))).toString('base64');
    const program=`$ErrorActionPreference='Stop'
$items=ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${data}')))
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$trusted=@($sid,'S-1-5-18','S-1-5-32-544')
foreach($item in $items){
 $acl=if(([IO.File]::GetAttributes($item.path) -band [IO.FileAttributes]::Directory) -ne 0){[IO.Directory]::GetAccessControl($item.path)}else{[IO.File]::GetAccessControl($item.path)}
 $owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
 $binary=$acl.GetSecurityDescriptorBinaryForm()
 $raw=[Security.AccessControl.RawSecurityDescriptor]::new($binary,0)
 if($owner -notin $trusted -or $null -eq $raw.DiscretionaryAcl){throw 'untrusted owner or DACL'}
 foreach($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){
  if($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or $rule.IdentityReference.Value -in $trusted){continue}
  $rights=[long]$rule.FileSystemRights.value__
  if(($rights -band 0x500D0156) -ne 0 -or ($item.sensitive -and ($rights -band 0x90000001) -ne 0)){throw 'untrusted access'}
 }
}
@{ok=$true;count=@($items).Count}|ConvertTo-Json -Compress`;
    try{
      const result=await promisify(execFile)('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(program,'utf16le').toString('base64')],
        {timeout:10_000,maxBuffer:4096,windowsHide:true});
      const proof=JSON.parse(result.stdout);if(proof.ok!==true||proof.count!==Math.min(10,entries.length-offset))throw new Error('acl');
    }catch{throw new Error('gateway.windows_permissions');}
  }
}
