/** Explicit fake live-parent registration for kernel file-policy integration tests.
 * Not a real SDK Agent. Keep the no-parent and unavailable-service cases explicit.
 */
export function attachFileParent(host, cwd, id='lead') {
  const parent={id,session:{id,header:{id,cwd}},ctx:host.ctx};
  if (!host.ctx.agents) host.ctx.agents=new Map();
  host.ctx.agents.set(id,parent);
  return parent;
}
