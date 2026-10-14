// ============================================================
// SINCRONIZAÇÃO DE BAIXA DE ESTOQUE POR COMANDA — fonte única.
//
// Compara o que a comanda VENDEU (itens_comanda tipo 'produto') com o que já
// foi BAIXADO para ela (movimentacoes_estoque com referencia_id = comanda) e
// grava só a DIFERENÇA:
//   - vendeu mais do que baixou  -> saida_venda da diferença
//   - baixou mais do que vende   -> ajuste positivo (devolve ao estoque)
//
// Por isso é idempotente: pode ser chamada quantas vezes quiser (finalizar,
// re-finalizar após reabrir, conciliação) sem nunca baixar 2x.
// Valor do item NÃO importa (produto zerado também sai do estoque).
//
// opts.zerar = true  -> trata a comanda como "não vendeu nada" (estorno):
//                       devolve tudo o que tinha sido baixado.
// ============================================================
const { supabaseAdmin } = require('../config/supabase')

const OBS_DEVOLUCAO = 'Devolução ao estoque (comanda corrigida/estornada)'

async function sincronizarBaixaComanda(comanda_id, opts = {}) {
  if (!comanda_id) return { baixas: 0, devolucoes: 0 }
  try {
    let unidade_id = opts.unidade_id || null
    let responsavel_id = opts.responsavel_id || null
    if (!unidade_id || !responsavel_id) {
      const { data: cmd } = await supabaseAdmin.from('comandas')
        .select('unidade_id, colaborador_id').eq('id', comanda_id).maybeSingle()
      if (!cmd) return { baixas: 0, devolucoes: 0 }
      unidade_id = unidade_id || cmd.unidade_id
      responsavel_id = responsavel_id || cmd.colaborador_id
    }
    if (!unidade_id) return { baixas: 0, devolucoes: 0 }

    // 1) o que a comanda vendeu (por produto)
    const vendido = {}
    if (!opts.zerar) {
      const { data: itens } = await supabaseAdmin.from('itens_comanda')
        .select('produto_id, quantidade, tipo').eq('comanda_id', comanda_id)
        .not('produto_id', 'is', null)
      ;(itens || []).forEach(it => {
        // aceita 'produto' / 'Produto' (front antigo manda maiúsculo)
        if (String(it.tipo || '').toLowerCase().indexOf('produto') === -1) return
        vendido[it.produto_id] = (vendido[it.produto_id] || 0) + (parseInt(it.quantidade) || 1)
      })
    }

    // 2) o que já foi baixado LÍQUIDO para esta comanda
    //    saídas (-) menos devoluções/ajustes ligados a ela (+)
    const { data: movs } = await supabaseAdmin.from('movimentacoes_estoque')
      .select('produto_id, quantidade, tipo').eq('referencia_id', comanda_id)
    const baixado = {}
    ;(movs || []).forEach(m => {
      const q = parseInt(m.quantidade) || 0
      if (String(m.tipo).startsWith('saida')) baixado[m.produto_id] = (baixado[m.produto_id] || 0) + q
      else if (String(m.tipo) === 'ajuste') baixado[m.produto_id] = (baixado[m.produto_id] || 0) - q
    })

    // 3) grava só a diferença
    let baixas = 0, devolucoes = 0
    const ids = new Set([...Object.keys(vendido), ...Object.keys(baixado)])
    for (const pid of ids) {
      const diff = (vendido[pid] || 0) - (baixado[pid] || 0)
      if (diff === 0) continue
      const linha = diff > 0
        ? { produto_id: pid, unidade_id, tipo: 'saida_venda', quantidade: diff,
            responsavel_id, referencia_id: comanda_id }
        : { produto_id: pid, unidade_id, tipo: 'ajuste', quantidade: -diff,
            responsavel_id, referencia_id: comanda_id, observacao: OBS_DEVOLUCAO }
      if (opts.observacao && diff > 0) linha.observacao = opts.observacao
      const { error } = await supabaseAdmin.from('movimentacoes_estoque').insert(linha)
      if (error) console.error('[estoque-sync]', comanda_id, pid, error.message)
      else if (diff > 0) baixas++
      else devolucoes++
    }
    return { baixas, devolucoes }
  } catch (e) {
    console.error('[estoque-sync] falha', comanda_id, e.message)
    return { baixas: 0, devolucoes: 0, erro: e.message }
  }
}

module.exports = { sincronizarBaixaComanda }
