/** Registered as "normalize" by examples/function-modules.json. */
export default async function normalize({ context, iteration }) {
  const name = String(context.name || 'Pipeline').trim();
  return {
    context: { normalizedName: name.toUpperCase() },
    resources: [{ name: `normalized-${iteration}.json`, type: 'application/json', value: { name } }],
  };
}
