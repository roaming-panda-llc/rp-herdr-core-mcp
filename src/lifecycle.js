import { z } from 'zod';
import { createHash } from 'node:crypto';
import { escapeInput } from './controls.js';
const integer=z.number().int().nonnegative().safe();
export const lifecycleInput=escapeInput.extend({action:z.enum(['terminate','remove_finished'])}).strict();
export const lifecyclePolicy=z.object({enabled:z.boolean().default(false),approvals:z.array(z.object({
  action_id:z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),terminal:escapeInput.shape.terminal,
  created_ms:integer,pid:integer.positive().nullable(),action:z.enum(['terminate','remove_finished']),
  status:z.enum(['idle','done','working','blocked','error']).nullable(),
  screen_sha256:z.string().regex(/^[a-f0-9]{64}$/),expires_ms:integer,
  work_preserved:z.literal(true),accept_nonatomic_targeting:z.literal(true),
  include_process_tree:z.literal(true),
  termination_scope:z.literal('root-and-all-local-remote-descendants').optional(),
  remove_terminal_artifacts:z.literal(true).optional(),
  purpose:z.literal('explicit-user-request')
}).strict().refine(a=>a.action!=='terminate'||(a.pid!==null&&a.termination_scope==='root-and-all-local-remote-descendants'),'Termination requires a live PID and explicit whole local/remote descendant scope').refine(a=>a.action!=='remove_finished'||a.remove_terminal_artifacts===true,'Removal requires explicit consent to delete stored screen and terminal uploads')).max(100).default([])}).strict().refine(p=>new Set(p.approvals.map(a=>a.action_id)).size===p.approvals.length,'Duplicate lifecycle action IDs');
const attempts=new WeakMap();
export async function controlLifecycle(ctx,input,signal){
  const args=lifecycleInput.parse(input),policy=ctx.config.lifecycle&&lifecyclePolicy.parse(ctx.config.lifecycle);
  if(args.host!==ctx.id||!ctx.config.coreId||!policy?.enabled)throw new Error('Lifecycle disabled or host/core mismatch');
  const a=policy.approvals.find(a=>a.action_id===args.action_id&&a.terminal===args.terminal&&a.action===args.action);
  if(!a)throw new Error('No exact lifecycle approval; idleness is not authorization');
  const check=()=>{if(signal?.aborted)throw new Error('Lifecycle cancelled before dispatch');if(Date.now()>=a.expires_ms)throw new Error('Lifecycle approval expired');};
  check();let used=attempts.get(ctx.core);if(!used)attempts.set(ctx.core,used=new Set());
  if(used.has(a.action_id))throw new Error('Lifecycle action already attempted; reconcile before new approval; no automatic retry');
  used.add(a.action_id);let dispatched=false;
  const list=async()=>{const r=await ctx.core.call('terminal.list',{all:true},ctx.config.coreId);if(!Array.isArray(r?.terminals))throw new Error('Invalid lifecycle readback');return r.terminals;};
  const verify=async()=>{const records=await list(),matches=records.filter(t=>t.address===args.terminal),t=matches.length===1?matches[0]:null;
    const descendants=new Set([args.terminal]); let changed=true;
    while(changed){changed=false;for(const child of records){if(child.parent!=null&&typeof child.parent!=='string')throw new Error('Ambiguous lifecycle child scope');const parent=child.parent?.split('/').at(-1);const address=typeof child.address==='string'?child.address.split('/').at(-1):null;if(!address)throw new Error('Ambiguous lifecycle child identity');if(parent&&descendants.has(parent)&&!descendants.has(address)){descendants.add(address);changed=true;}}}
    if(records.some(child=>child.address!==args.terminal&&descendants.has(child.address.split('/').at(-1))&&child.state!=='finished'))throw new Error('Lifecycle target has live child terminals; preserve and reconcile each child first');
    if(!t||t.created_ms!==a.created_ms||t.pid!==a.pid||t.state!==(a.action==='terminate'?'live':'finished')||(t.status?.state??null)!==a.status||(a.action==='terminate'&&t.reason))throw new Error('Lifecycle target no longer matches approved lifetime/PID/state');check();};
  try{
    await verify();const screen=await ctx.core.call('terminal.read',{terminal:args.terminal,lines:0},ctx.config.coreId);
    if(screen?.complete!==true||typeof screen.text!=='string'||createHash('sha256').update(screen.text).digest('hex')!==a.screen_sha256)throw new Error('Lifecycle screen differs from inspected approval');
    await verify();check();dispatched=true;
    const method=a.action==='terminate'?'terminal.kill':'terminal.rm';
    try{
      const r=await ctx.core.call(method,{terminal:args.terminal},ctx.config.coreId,{signal,deadlineMs:a.expires_ms,requiredVersion:'0.1.18'});
      if(a.action==='terminate'?(r?.address!==args.terminal||r.created_ms!==a.created_ms||r.state!=='finished'):r?.removed!==args.terminal)throw new Error('Unexpected lifecycle acknowledgement');
      const remaining=(await list()).filter(t=>t.address===args.terminal);
      const verified=a.action==='terminate'?remaining.length===1&&remaining[0].created_ms===a.created_ms&&remaining[0].state==='finished':remaining.length===0;
      if(!verified)throw new Error('Lifecycle postcondition not verified');
      return {host:ctx.id,terminal:args.terminal,created_ms:a.created_ms,action:a.action,verified:true,observation:a.action==='terminate'?'core_reports_finished':'core_record_absent',os_process_exit_verified:false,remote_descendant_exit_verified:false,gui_window_closed:'unverified',atomic_lifetime_guard:false};
    }catch(error){throw new Error('Lifecycle outcome UNKNOWN; reconcile terminal and process before any new approval; no automatic retry',{cause:error});}
  }finally{if(!dispatched)used.delete(a.action_id);}
}
