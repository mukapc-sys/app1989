const express = require('express')
const router  = express.Router()
const { supabaseAdmin } = require('../config/supabase')
const { autenticar, exigirPerfil } = require('../middleware/auth')
const { loadKnowledge } = require('../knowledge')

router.post('/chat', autenticar, exigirPerfil('proprietario', 'gerente', 'colaborador'), async (req, res) => {
  try {
    const { mensagem, historico = [] } = req.body
    if (!mensagem) return res.status(400).json({ erro: 'Mensagem é obrigatória' })

    const u           = req.usuario
    const perfil      = u.perfil
    const unidadeId   = u.unidade_id
    const colaboradorId = u.id
    const hoje        = new Date().toISOString().split('T')[0]
    const inicioMes   = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString()
    const inicioMesAnterior = new Date(new Date().getFullYear(), new Date().getMonth() - 1, 1).toISOString()
    const fimMesAnterior    = new Date(new Date().getFullYear(), new Date().getMonth(), 0).toISOString()

    let contexto = ''

    // ============================================================
    // COLABORADOR — dados pessoais + coaching
    // ============================================================
    if (perfil === 'colaborador') {
      const [rMeusAgend, rMeusAgendMesAnt, rMeusProdutos, rMeusClientes, rColabInfo] = await Promise.all([
        supabaseAdmin.from('agendamentos')
          .select('status, data_hora_ini, data_hora_fim, clientes(nome), servicos(nome, valor)')
          .eq('colaborador_id', colaboradorId)
          .gte('data_hora_ini', inicioMes),
        supabaseAdmin.from('agendamentos')
          .select('status, data_hora_ini')
          .eq('colaborador_id', colaboradorId)
          .gte('data_hora_ini', inicioMesAnterior)
          .lte('data_hora_ini', fimMesAnterior),
        supabaseAdmin.from('itens_comanda')
          .select('descricao, quantidade, valor_unit, comandas(colaborador_id, finalizada_em, status)')
          .eq('tipo', 'produto'),
        supabaseAdmin.from('agendamentos')
          .select('cliente_id, clientes(nome), data_hora_ini, status')
          .eq('colaborador_id', colaboradorId)
          .eq('status', 'concluido')
          .order('data_hora_ini', { ascending: false })
          .limit(100),
        supabaseAdmin.from('colaboradores')
          .select('nome, comissao_pct, unidades(nome)')
          .eq('id', colaboradorId)
          .single()
      ])

      const agends     = rMeusAgend.data || []
      const agendsMesAnt = rMeusAgendMesAnt.data || []
      const concluidos = agends.filter(a => a.status === 'concluido')
      const cancelados = agends.filter(a => a.status === 'cancelado')
      const naoVieram  = agends.filter(a => a.status === 'nao_compareceu')
      const colab      = rColabInfo.data || {}

      // Faturamento próprio
      const fatProprio = concluidos.reduce((s, a) => s + parseFloat(a.servicos?.valor || 0), 0)
      const comissao   = fatProprio * (colab.comissao_pct || 0) / 100

      // Horários mais atendidos
      const horarioCount = {}
      concluidos.forEach(a => {
        const h = new Date(a.data_hora_ini).getHours()
        horarioCount[h] = (horarioCount[h] || 0) + 1
      })
      const topHorario = Object.entries(horarioCount).sort((a,b) => b[1]-a[1]).slice(0,3).map(([h,c]) => `${h}h (${c}x)`).join(', ')

      // Clientes únicos e recorrentes
      const clientesUnicos = [...new Set(concluidos.map(a => a.cliente_id).filter(Boolean))]
      const clienteVisitas = {}
      concluidos.forEach(a => {
        if (a.cliente_id) clienteVisitas[a.cliente_id] = (clienteVisitas[a.cliente_id]||0)+1
      })
      const recorrentes = Object.values(clienteVisitas).filter(v => v > 1).length

      // Clientes ausentes há mais de 15 dias
      const ausentes = []
      const clienteUltimaVisita = {}
      concluidos.forEach(a => {
        if (a.cliente_id && a.clientes?.nome) {
          const data = new Date(a.data_hora_ini)
          if (!clienteUltimaVisita[a.cliente_id] || data > clienteUltimaVisita[a.cliente_id].data) {
            clienteUltimaVisita[a.cliente_id] = { data, nome: a.clientes.nome }
          }
        }
      })
      Object.values(clienteUltimaVisita).forEach(c => {
        const dias = Math.floor((new Date() - c.data) / 86400000)
        if (dias >= 15) ausentes.push({ nome: c.nome, dias })
      })
      ausentes.sort((a,b) => b.dias - a.dias)

      // Produtos vendidos
      const prodVendidos = (rMeusProdutos.data||[]).filter(i =>
        i.comandas?.colaborador_id === colaboradorId && i.comandas?.status === 'finalizada'
      )

      contexto = `Você é o assistente pessoal de performance do barbeiro ${colab.nome || 'colaborador'} da Barbearia 1989 (${colab.unidades?.nome || ''}).

Sua missão é ser um COACH de alta performance: analisar os dados reais, identificar padrões, propor ações concretas e motivar o barbeiro a crescer. Seja direto, honesto e sempre propositivo. Use dados para embasar cada sugestão.

=== DADOS DO MÊS ATUAL ===

👤 BARBEIRO: ${colab.nome}
💼 Comissão: ${colab.comissao_pct}%

📊 ATENDIMENTOS:
- Total agendado: ${agends.length}
- Concluídos: ${concluidos.length}
- Cancelados: ${cancelados.length}
- Não compareceram: ${naoVieram.length}
- Taxa de conclusão: ${agends.length ? ((concluidos.length/agends.length)*100).toFixed(1) : 0}%
- Mês anterior: ${agendsMesAnt.filter(a=>a.status==='concluido').length} concluídos

💰 FINANCEIRO:
- Faturamento gerado: R$ ${fatProprio.toFixed(2)}
- Sua comissão: R$ ${comissao.toFixed(2)}

⏰ HORÁRIOS MAIS PRODUTIVOS: ${topHorario || 'sem dados'}

👥 CLIENTES:
- Clientes únicos atendidos: ${clientesUnicos.length}
- Clientes recorrentes: ${recorrentes}
- Clientes ausentes há +15 dias: ${ausentes.length}
${ausentes.slice(0,5).map(c => `  → ${c.nome}: ${c.dias} dias sem visita`).join('\n')}

🛍️ PRODUTOS VENDIDOS: ${prodVendidos.length} itens no mês

=== DIRETRIZES DO SEU COACHING ===
1. Analise os números e identifique pontos de melhoria específicos
2. Sugira ações concretas para reativar clientes ausentes (com script de mensagem)
3. Proponha estratégias para aumentar ticket médio (venda de produtos, serviços combinados)
4. Identifique os horários ociosos e sugira como preenchê-los
5. Compare com o mês anterior e celebre melhorias ou sinalize quedas
6. Seja motivador mas realista — use os números para embasar tudo`

    // ============================================================
    // GERENTE — sua unidade + coaching da equipe
    // ============================================================
    } else if (perfil === 'gerente') {
      const [rUnidade, rColabs, rAgends, rFinMes, rFinHoje, rEstoque, rReativar] = await Promise.all([
        supabaseAdmin.from('unidades').select('nome').eq('id', unidadeId).single(),
        supabaseAdmin.from('colaboradores').select('id, nome, comissao_pct').eq('unidade_id', unidadeId).eq('ativo', true).eq('perfil', 'colaborador'),
        supabaseAdmin.from('agendamentos')
          .select('colaborador_id, status, data_hora_ini, clientes(nome)')
          .eq('unidade_id', unidadeId)
          .gte('data_hora_ini', inicioMes),
        supabaseAdmin.from('vw_comissoes_mes').select('*'),
        supabaseAdmin.from('vw_financeiro_dia').select('*').eq('data', hoje).eq('unidade_id', unidadeId),
        supabaseAdmin.from('vw_estoque_alertas').select('*').eq('critico', true).eq('unidade_id', unidadeId),
        supabaseAdmin.from('vw_clientes_reativar').select('*').limit(10)
      ])

      const nomeUnidade = rUnidade.data?.nome || 'sua unidade'
      const colabs      = rColabs.data || []
      const agends      = rAgends.data || []
      const comissoes   = (rFinMes.data||[]).filter(c => c.unidade_nome === nomeUnidade)
      const fatHoje     = (rFinHoje.data||[]).reduce((s,r) => s+parseFloat(r.faturamento||0), 0)

      // Performance por barbeiro
      const perfBarbeiro = colabs.map(col => {
        const ag  = agends.filter(a => a.colaborador_id === col.id)
        const ok  = ag.filter(a => a.status === 'concluido')
        const com = comissoes.find(c => c.colaborador_nome === col.nome)
        const horCount = {}
        ok.forEach(a => { const h = new Date(a.data_hora_ini).getHours(); horCount[h] = (horCount[h]||0)+1 })
        const topH = Object.entries(horCount).sort((a,b)=>b[1]-a[1])[0]
        return {
          nome: col.nome,
          total: ag.length,
          concluidos: ok.length,
          taxa: ag.length ? ((ok.length/ag.length)*100).toFixed(1) : 0,
          faturado: com ? parseFloat(com.faturado||0).toFixed(2) : '0.00',
          comissao: com ? parseFloat(com.comissao||0).toFixed(2) : '0.00',
          horarioPico: topH ? `${topH[0]}h` : 'N/A'
        }
      })

      contexto = `Você é o assistente de gestão do GERENTE da ${nomeUnidade} — Barbearia 1989.

Sua missão: ajudar o gerente a LIDERAR e DESENVOLVER a equipe. Analise performance coletiva e individual, identifique quem precisa de apoio, quem está se destacando, e proponha ações de gestão concretas.

=== DADOS DA ${nomeUnidade.toUpperCase()} ===

📅 FATURAMENTO HOJE: R$ ${fatHoje.toFixed(2)}

👥 EQUIPE (${colabs.length} barbeiros):
${perfBarbeiro.map(b => `
🔹 ${b.nome}
   - Agendamentos: ${b.total} / Concluídos: ${b.concluidos} (${b.taxa}%)
   - Faturou: R$ ${b.faturado} / Comissão: R$ ${b.comissao}
   - Horário de pico: ${b.horarioPico}`).join('\n')}

⚠️ ESTOQUE CRÍTICO:
${(rEstoque.data||[]).map(e=>`- ${e.produto_nome}: ${e.quantidade} un.`).join('\n')||'- Nenhum crítico'}

🔄 CLIENTES A REATIVAR: ${(rReativar.data||[]).length} clientes há +15 dias sem visita

=== DIRETRIZES DE LIDERANÇA ===
1. Compare performance entre barbeiros — identifique destaque e quem precisa de suporte
2. Sugira ações de coaching individuais baseadas nos números
3. Proponha estratégias para a unidade crescer como time
4. Identifique horários ociosos da unidade e sugira campanhas para preenchê-los
5. Ajude o gerente a ter conversas difíceis com dados (ex: barbeiro com baixa taxa de conclusão)
6. Sugira ações de marketing local para aumentar movimento`

    // ============================================================
    // PROPRIETÁRIO — visão completa + gestão estratégica
    // ============================================================
    } else {
      const [rUnidades, rColabs, rAgendsMes, rFinMes, rFinHoje, rComissoes, rEstoque, rReativar, rPlanos] = await Promise.all([
        supabaseAdmin.from('unidades').select('id, nome').eq('ativa', true),
        supabaseAdmin.from('colaboradores').select('id, nome, perfil, comissao_pct, unidade_id, unidades(nome)').eq('ativo', true),
        supabaseAdmin.from('agendamentos').select('colaborador_id, unidade_id, status, data_hora_ini').gte('data_hora_ini', inicioMes),
        supabaseAdmin.from('comandas').select('total, unidade_id, colaborador_id').eq('status','finalizada').gte('finalizada_em', inicioMes),
        supabaseAdmin.from('vw_financeiro_dia').select('*').eq('data', hoje),
        supabaseAdmin.from('vw_comissoes_mes').select('*'),
        supabaseAdmin.from('vw_estoque_alertas').select('*').eq('critico', true),
        supabaseAdmin.from('vw_clientes_reativar').select('*').limit(20),
        supabaseAdmin.from('assinaturas').select('status, planos(nome)').eq('status','ativa')
      ])

      const unidades  = rUnidades.data || []
      const colabs    = rColabs.data   || []
      const agends    = rAgendsMes.data || []
      const fin       = rFinMes.data   || []
      const fatTotal  = fin.reduce((s,c) => s+parseFloat(c.total||0), 0)
      const fatHoje   = (rFinHoje.data||[]).reduce((s,r) => s+parseFloat(r.faturamento||0), 0)

      // Performance por unidade
      const perfUnidade = unidades.map(uni => {
        const agU  = agends.filter(a => a.unidade_id === uni.id)
        const finU = fin.filter(f => f.unidade_id === uni.id)
        const fatU = finU.reduce((s,c) => s+parseFloat(c.total||0), 0)
        const gerente = colabs.find(c => c.unidade_id === uni.id && c.perfil === 'gerente')
        const barbs   = colabs.filter(c => c.unidade_id === uni.id && c.perfil === 'colaborador')
        return {
          nome: uni.nome,
          gerente: gerente?.nome || 'Sem gerente',
          barbeiros: barbs.length,
          atendimentos: agU.filter(a=>a.status==='concluido').length,
          faturamento: fatU.toFixed(2),
          ticketMedio: finU.length ? (fatU/finU.length).toFixed(2) : '0'
        }
      })

      // Performance por barbeiro (todos)
      const barbeiros = colabs.filter(c => c.perfil === 'colaborador')
      const perfBarb  = barbeiros.map(b => {
        const ag  = agends.filter(a => a.colaborador_id === b.id)
        const ok  = ag.filter(a => a.status === 'concluido')
        const com = (rComissoes.data||[]).find(c => c.colaborador_nome === b.nome)
        return {
          nome: b.nome,
          unidade: b.unidades?.nome || '',
          atendimentos: ok.length,
          taxa: ag.length ? ((ok.length/ag.length)*100).toFixed(1) : 0,
          faturado: com ? parseFloat(com.faturado||0).toFixed(2) : '0.00',
          comissao: com ? parseFloat(com.comissao||0).toFixed(2) : '0.00'
        }
      }).sort((a,b) => parseFloat(b.faturado)-parseFloat(a.faturado))

      contexto = `Você é o consultor estratégico exclusivo do PROPRIETÁRIO da Barbearia 1989 — rede com ${unidades.length} unidades em Montenegro/RS.

Sua missão: entregar INTELIGÊNCIA DE NEGÓCIO real. Analise dados com visão de dono, identifique oportunidades de crescimento, riscos operacionais e ações de alto impacto. Seja o consultor que todo empresário precisa — direto, baseado em dados, com visão estratégica.

=== VISÃO GERAL DO NEGÓCIO ===

📅 HOJE: R$ ${fatHoje.toFixed(2)} faturados
📊 MÊS ATUAL: R$ ${fatTotal.toFixed(2)} total | ${fin.length} comandas | Ticket médio: R$ ${fin.length ? (fatTotal/fin.length).toFixed(2) : '0'}
📋 ASSINATURAS ATIVAS: ${(rPlanos.data||[]).length} clientes
🔄 CLIENTES A REATIVAR: ${(rReativar.data||[]).length} clientes inativos

=== PERFORMANCE POR UNIDADE ===
${perfUnidade.map(u => `
🏪 ${u.nome}
   Gerente: ${u.gerente} | ${u.barbeiros} barbeiros
   Atendimentos: ${u.atendimentos} | Faturamento: R$ ${u.faturamento} | Ticket médio: R$ ${u.ticketMedio}`).join('\n')}

=== RANKING DE BARBEIROS ===
${perfBarb.map((b,i) => `${i+1}. ${b.nome} (${b.unidade}) — ${b.atendimentos} atend. | R$ ${b.faturado} | taxa ${b.taxa}%`).join('\n')}

=== ESTOQUE CRÍTICO ===
${(rEstoque.data||[]).map(e=>`- ${e.produto_nome}: ${e.quantidade} un. (${e.unidade_nome})`).join('\n')||'- Nenhum crítico'}

=== CLIENTES A REATIVAR (TOP 10) ===
${(rReativar.data||[]).slice(0,10).map(c=>`- ${c.nome}: ${Math.round(c.dias_ausente)} dias`).join('\n')||'- Nenhum'}

=== SUAS CAPACIDADES COMO CONSULTOR ===
1. Relatório completo de qualquer unidade com análise por barbeiro
2. Relatório de desempenho de gerentes (crescimento da equipe, ocupação, faturamento da unidade)
3. Análise de barbeiro específico: horas trabalhadas, horários ociosos, taxa de retorno, vendas
4. Sugestões de ações de marketing segmentadas por comportamento de cliente
5. Alertas de risco: barbeiros com queda de performance, unidades abaixo da média
6. Comparativo entre unidades e entre períodos
7. Estratégias de vendas, retenção e crescimento de receita recorrente (planos)
8. Scripts prontos para campanhas de reativação e upsell`
    }

    // ---- Carrega base de conhecimento ----
    const knowledge = await loadKnowledge(supabaseAdmin)
    const contextoFinal = contexto + `

=== BASE DE CONHECIMENTO — USE PARA ENRIQUECER SUAS RESPOSTAS ===
${knowledge}

INSTRUÇÕES DE USO DO CONHECIMENTO:
- Use estas metodologias para embasar TODAS as suas sugestões
- Quando propuser uma ação, cite a lógica por trás (ex: "Segundo a metodologia de retenção, cliente que retorna em 21 dias...")
- Adapte o conhecimento à realidade da Barbearia 1989 e Montenegro/RS
- Seja prático: conhecimento sem ação não tem valor
- Sempre termine com 1-3 ações concretas que podem ser feitas hoje ou esta semana
`

    // ---- Chama GPT-3.5-turbo ----
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + process.env.OPENAI_API_KEY },
      body: JSON.stringify({
        model: 'gpt-3.5-turbo',
        max_tokens: 1000,
        temperature: 0.6,
        messages: [
          { role: 'system', content: contextoFinal },
          ...historico.slice(-8),
          { role: 'user', content: mensagem }
        ]
      })
    })

    if (!response.ok) {
      const err = await response.json()
      throw new Error(err.error?.message || 'Erro na API OpenAI')
    }

    const data = await response.json()
    return res.json({ resposta: data.choices[0].message.content, perfil, tokens_usados: data.usage?.total_tokens || 0 })

  } catch (err) {
    console.error('Erro no assistente:', err)
    return res.status(500).json({ erro: 'Erro ao processar: ' + err.message })
  }
})

module.exports = router
