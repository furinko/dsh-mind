/** Test-only drain; caller first disposes its host and passes that host's already shared Org. */
export async function drainKernelAudit(org, operations = []) {
  await Promise.all(operations);
  await org.observability.flush();
  // Also serialize behind the ordinary audit writer; observation flush is not a business-operation join.
  await org.audit.readVerified();
}
