export const name = 'brief';

export async function handler(args, ctx) {
  const { briefData } = await import('../../domain/analysis/brief.js');
  return briefData(args.file, ctx.dbPath, {
    noTests: args.no_tests,
  });
}
