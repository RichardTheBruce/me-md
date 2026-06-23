import type { EngineClient } from "../engine/client.js";

export async function embedTexts(
  engine: EngineClient,
  model: string,
  texts: string[],
  batch = 32,
): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += batch) {
    const slice = texts.slice(i, i + batch);
    const vecs = await engine.embed(model, slice);
    out.push(...vecs);
  }
  return out;
}
