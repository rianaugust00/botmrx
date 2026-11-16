// Porta ExtratorDeResumo com o adaptador para o Claude (saída estruturada + validação).
import { carregarPrompt, carregarSchema, montarMensagemUsuario } from './prompt.js';
import { validarResumo } from './validar.js';

/**
 * @typedef {{
 *   time: { id: number, nome: string },
 *   data: string,
 *   participantes: { id: number, nome: string }[],
 *   bloqueiosAbertos: { id: number, participanteId: number, participanteNome?: string, desde: string, descricao: string }[],
 *   falas: { id: number, participanteId: number, inicioMs: number, fimMs?: number, texto: string }[],
 * }} EntradaExtracao   docs/CONTRATOS.md §3
 */

export class ErroExtracao extends Error {}

/**
 * @param {object} o
 * @param {import('@anthropic-ai/sdk').default} o.client
 * @param {string} [o.modelo]
 * @param {'low'|'medium'|'high'|'xhigh'|'max'} [o.effort]
 * @param {boolean} [o.fallback] fallback automático do servidor em caso de recusa
 * @returns {(entrada: EntradaExtracao) => Promise<{ resumo: any, avisos: string[], bruto: any, meta: object }>}
 */
export function criarExtrator({ client, modelo = 'claude-opus-5-5', effort = 'medium', fallback = true }) {
  return async function extrair(entrada) {
    if (entrada.falas.length === 0) throw new ErroExtracao('A transcrição não tem falas.');

    const [prompt, schema] = await Promise.all([carregarPrompt(), carregarSchema()]);
    const mensagem = montarMensagemUsuario(prompt.templateUsuario, entrada);

    const resposta = await client.beta.messages.create({
      model: modelo,
      max_tokens: 16000,
      system: prompt.system,
      messages: [{ role: 'user', content: mensagem }],
      output_config: { effort, format: { type: 'json_schema', schema } },
      ...(fallback && { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }),
    });

    if (resposta.stop_reason === 'refusal') {
      const d = resposta.stop_details;
      throw new ErroExtracao(`O modelo recusou a extração (${d?.category ?? 'sem categoria'}): ${d?.explanation ?? ''}`);
    }
    if (resposta.stop_reason === 'max_tokens') {
      throw new ErroExtracao('Resposta cortada por max_tokens; aumente o limite ou reduza o effort.');
    }

    const texto = resposta.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('');
    let bruto;
    try {
      bruto = JSON.parse(texto);
    } catch {
      throw new ErroExtracao(`Resposta não é JSON válido: ${texto.slice(0, 300)}`);
    }

    const { resumo, avisos } = validarResumo(bruto, entrada, entrada.bloqueiosAbertos);
    return {
      resumo,
      avisos,
      bruto,
      meta: {
        modelo: resposta.model,
        versaoPrompt: prompt.versao,
        effort,
        tokensEntrada: resposta.usage.input_tokens,
        tokensSaida: resposta.usage.output_tokens,
      },
    };
  };
}
