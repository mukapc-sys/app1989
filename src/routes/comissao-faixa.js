// ============================================================================
// comissao-faixa.js
// Motor de comissão POR FAIXA (progressiva), usado em vários lugares.
//
// SERVIÇOS — a faixa depende do total de SERVIÇO do barbeiro no período (mês),
//   e a % vale para TUDO (não é marginal):
//     0 a 7.999      -> 40%
//     8.000 a 10.999 -> 45%
//     11.000+        -> 50%
//
// PRODUTOS — a faixa depende da QUANTIDADE de unidades vendidas no período,
//   e a % cai sobre o VALOR dos produtos:
//     0 a 9 un   -> 10%
//     10 a 19 un -> 20%
//     20+ un     -> 30%
//
// Fonte de dados: itens_comanda de comandas FINALIZADAS no período.
// ============================================================================

const { supabaseAdmin } = require('../config/supabase')

function pctServico(total) { return total < 8000 ? 40 : (total < 11000 ? 45 : 50) }
function pctProduto(unid)  { return unid  < 10   ? 10 : (unid  < 20    ? 20 : 30) }
function round(n) { return Math.round((Number(n) || 0) * 100) / 100 }

/**
 * Calcula a comissão por faixa de cada barbeiro num intervalo.
 * @param {object} opts { ini, fim }  ISO strings;  fim é EXCLUSIVO
 * @param {string|null} opts.unidade_id  filtra por unidade (null = todas)
 * @returns {Promise<{linhas:Array, total_comissao:number, total_servico:number, total_produto:number}>}
 */
async function calcularComissaoFaixa({ ini, fim, unidade_id = null }) {
  let q = supabaseAdmin
    .from('itens_comanda')
    .select('tipo, quantidade, valor_unit, comandas!inner(colaborador_id, unidade_id, status, finalizada_em)')
    .eq('comandas.status', 'finalizada')
    .gte('comandas.finalizada_em', ini)
    .lt('comandas.finalizada_em', fim)
  if (unidade_id) q = q.eq('comandas.unidade_id', unidade_id)

  const { data: itens, error } = await q
  if (error) throw error

  // Agrega por barbeiro
  const acc = {}
  for (const it of (itens || [])) {
    const cid = it.comandas && it.comandas.colaborador_id
    if (!cid) continue
    if (!acc[cid]) acc[cid] = { servico_total: 0, produto_total: 0, produto_unid: 0, plano_total: 0 }
    const qtd = parseInt(it.quantidade) || 1
    const valor = (parseFloat(it.valor_unit) || 0) * qtd
    const tipo = String(it.tipo || '').toLowerCase()
    if (tipo.indexOf('produto') !== -1) {
      acc[cid].produto_total += valor
      acc[cid].produto_unid += qtd
    } else {
      // serviço, corte E plano entram aqui (plano segue a MESMA regra de serviço)
      acc[cid].servico_total += valor
      if (tipo.indexOf('plano') !== -1) acc[cid].plano_total += valor // medição separada
    }
  }

  // Nomes dos barbeiros
  const ids = Object.keys(acc)
  const nomes = {}
  if (ids.length) {
    const { data: cols } = await supabaseAdmin.from('colaboradores').select('id, nome').in('id', ids)
    ;(cols || []).forEach(c => { nomes[c.id] = c.nome })
  }

  const linhas = ids.map(cid => {
    const a = acc[cid]
    const sPct = pctServico(a.servico_total)
    const pPct = pctProduto(a.produto_unid)
    const sCom = a.servico_total * sPct / 100
    const pCom = a.produto_total * pPct / 100
    return {
      colaborador_id: cid,
      nome: nomes[cid] || '—',
      servico_total: round(a.servico_total),
      servico_pct: sPct,
      servico_comissao: round(sCom),
      produto_total: round(a.produto_total),
      produto_unidades: a.produto_unid,
      produto_pct: pPct,
      produto_comissao: round(pCom),
      plano_total: round(a.plano_total),
      comissao_total: round(sCom + pCom)
    }
  }).sort((x, y) => y.comissao_total - x.comissao_total)

  return {
    linhas,
    total_comissao: round(linhas.reduce((s, l) => s + l.comissao_total, 0)),
    total_servico: round(linhas.reduce((s, l) => s + l.servico_total, 0)),
    total_produto: round(linhas.reduce((s, l) => s + l.produto_total, 0))
  }
}

// Limites ISO do mês de uma data (default: hoje). Retorna { ini, fim } com fim exclusivo.
function limitesMes(ref) {
  const d = ref ? new Date(ref) : new Date()
  const y = d.getFullYear(), m = d.getMonth() // 0-11
  const ini = new Date(Date.UTC(y, m, 1)).toISOString()
  const fim = new Date(Date.UTC(m === 11 ? y + 1 : y, m === 11 ? 0 : m + 1, 1)).toISOString()
  return { ini, fim }
}

module.exports = { calcularComissaoFaixa, pctServico, pctProduto, limitesMes }
