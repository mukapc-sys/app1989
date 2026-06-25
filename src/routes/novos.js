const express = require('express')
const router  = express.Router()
const bcrypt  = require('bcryptjs')
const { supabaseAdmin } = require('../config/supabase')
const { autenticar, exigirPerfil } = require('../middleware/auth')
const { validarSenhaAutorizacao } = require('../middleware/autorizacao')

const ADMIN    = exigirPerfil('proprietario')
const ADM_GER  = exigirPerfil('proprietario','gerente')
const TODOS    = exigirPerfil('proprietario','gerente','colaborador','caixa')

// Normaliza a forma de pagamento para os valores que o banco aceita.
function normalizarForma(f) {
  const s = String(f || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  if (s.includes('din')) return 'dinheiro'
  if (s.includes('cred')) return 'credito'
  if (s.includes('deb')) return 'debito'
  if (s.includes('pix')) return 'pix'
  return 'dinheiro'
}

// ============================================================
// AUTORIZAÇÃO DO GERENTE — senha que libera ações sensíveis do caixa
// ============================================================
// O gestor (gerente/proprietário) logado define/atualiza a PRÓPRIA senha.
router.post('/autorizacao/definir', autenticar, ADM_GER, async (req, res) => {
  try {
    const senha = String(req.body.senha || '')
    if (senha.length < 4) {
      return res.status(400).json({ erro: 'A senha de autorização precisa ter ao menos 4 caracteres.' })
    }
    const hash = await bcrypt.hash(senha, 10)
    const { error } = await supabaseAdmin
      .from('colaboradores').update({ senha_autorizacao: hash }).eq('id', req.usuario.id)
    if (error) throw error
    return res.json({ ok: true })
  } catch (err) {
    console.error('[autorizacao/definir]', err.message)
    return res.status(500).json({ erro: 'Erro ao salvar senha de autorização' })
  }
})

// Diz se o gestor logado já tem senha de autorização definida.
router.get('/autorizacao/status', autenticar, async (req, res) => {
  try {
    const { data } = await supabaseAdmin
      .from('colaboradores').select('senha_autorizacao').eq('id', req.usuario.id).single()
    return res.json({ definida: !!(data && data.senha_autorizacao) })
  } catch (err) {
    return res.json({ definida: false })
  }
})


// ============================================================
// VALE PIX
// ============================================================
router.post('/vales-pix', autenticar, ADM_GER, async (req, res) => {
  try {
    const { colaborador_id, valor, descricao } = req.body
    const { data: colab } = await supabaseAdmin.from('colaboradores').select('id,unidade_id,saldo_vales_pix,nome').eq('id', colaborador_id).single()
    if (!colab) return res.status(404).json({ erro: 'Colaborador não encontrado' })

    const { data, error } = await supabaseAdmin.from('vales_pix').insert({
      colaborador_id, valor, descricao,
      unidade_id: colab.unidade_id,
      criado_por: req.usuario.colaborador_id,
      status: 'pendente'
    }).select().single()
    if (error) throw error

    // Atualiza saldo de vales do barbeiro
    await supabaseAdmin.from('colaboradores').update({
      saldo_vales_pix: (parseFloat(colab.saldo_vales_pix) || 0) + parseFloat(valor)
    }).eq('id', colaborador_id)

    return res.status(201).json(data)
  } catch (err) {
    console.error('[vales-pix]', err)
    return res.status(500).json({ erro: 'Erro ao registrar vale PIX' })
  }
})

router.get('/vales-pix', autenticar, ADM_GER, async (req, res) => {
  try {
    const { colaborador_id, status } = req.query
    let q = supabaseAdmin.from('vales_pix').select('*,colaboradores(nome),criador:criado_por(nome)').order('criado_em', { ascending: false })
    if (colaborador_id) q = q.eq('colaborador_id', colaborador_id)
    if (status) q = q.eq('status', status)
    const { data } = await q
    return res.json(data || [])
  } catch (err) {
    return res.status(500).json({ erro: 'Erro ao buscar vales PIX' })
  }
})

// ============================================================
// REABRIR COMANDA (senha do gerente)
// ============================================================
router.post('/comandas/:id/reabrir', autenticar, async (req, res) => {
  try {
    const { senha_gerente, motivo } = req.body
    const { id } = req.params
    if (!motivo || !String(motivo).trim()) {
      return res.status(400).json({ erro: 'Informe o motivo da reabertura.' })
    }

    // Quem autoriza? O próprio gestor logado, OU alguém via senha de autorização.
    let autorizador = null
    if (['gerente', 'proprietario'].includes(req.usuario.perfil)) {
      autorizador = { id: req.usuario.id, nome: req.usuario.nome }
    } else {
      autorizador = await validarSenhaAutorizacao(senha_gerente)
      if (!autorizador) {
        return res.status(403).json({ erro: 'Senha de autorização inválida.' })
      }
    }

    // Reabre a comanda
    const { error } = await supabaseAdmin.from('comandas')
      .update({ status: 'aberta', status_pagamento: 'aberta' }).eq('id', id)
    if (error) throw error

    // Registra log: quem autorizou + motivo
    await supabaseAdmin.from('log_reaberturas').insert({
      comanda_id: id, gerente_id: autorizador.id, motivo: motivo
    })

    return res.json({ ok: true, autorizado_por: autorizador.nome })
  } catch (err) {
    console.error('[reabrir]', err.message)
    return res.status(500).json({ erro: 'Erro ao reabrir comanda' })
  }
})

// ============================================================
// FOLGAS
// ============================================================
router.get('/folgas', autenticar, async (req, res) => {
  try {
    const { colaborador_id, unidade_id, mes } = req.query
    let q = supabaseAdmin.from('folgas').select('*,colaboradores(nome,unidades(nome))').order('data_folga')
    if (colaborador_id) q = q.eq('colaborador_id', colaborador_id)
    if (unidade_id)     q = q.eq('unidade_id', unidade_id)
    if (mes)            q = q.gte('data_folga', mes + '-01').lte('data_folga', mes + '-31')
    const { data } = await q
    return res.json(data || [])
  } catch (err) {
    return res.status(500).json({ erro: 'Erro ao buscar folgas' })
  }
})

router.post('/folgas', autenticar, async (req, res) => {
  try {
    const { colaborador_id, data_folga, periodo, obs } = req.body
    const { data: colab } = await supabaseAdmin.from('colaboradores').select('id,unidade_id,perfil').eq('user_id', req.usuario.id).single()

    // Barbeiro só pode pedir folga para si mesmo; gerente/admin pode para qualquer um
    const target_id = ['gerente','proprietario'].includes(colab?.perfil) ? (colaborador_id || colab.id) : colab.id
    const { data: target } = await supabaseAdmin.from('colaboradores').select('unidade_id').eq('id', target_id).single()

    const { data, error } = await supabaseAdmin.from('folgas').insert({
      colaborador_id: target_id,
      unidade_id: target.unidade_id,
      data_folga, periodo: periodo || 'dia_todo',
      status: ['gerente','proprietario'].includes(colab?.perfil) ? 'aprovada' : 'solicitada',
      aprovado_por: ['gerente','proprietario'].includes(colab?.perfil) ? colab.id : null,
      obs
    }).select().single()
    if (error) throw error
    return res.status(201).json(data)
  } catch (err) {
    console.error('[folgas]', err)
    return res.status(500).json({ erro: 'Erro ao registrar folga' })
  }
})

router.delete('/folgas/:id', autenticar, ADM_GER, async (req, res) => {
  try {
    await supabaseAdmin.from('folgas').update({ status: 'cancelada' }).eq('id', req.params.id)
    return res.json({ ok: true })
  } catch (err) {
    return res.status(500).json({ erro: 'Erro ao cancelar folga' })
  }
})

// Desbloquear agenda (cancelar folga do dia)
router.post('/folgas/desbloquear', autenticar, ADM_GER, async (req, res) => {
  try {
    const { colaborador_id, data_folga, horarios } = req.body
    // Se horários específicos → cria novo registro parcial; se dia todo → apenas cancela
    await supabaseAdmin.from('folgas').update({ status: 'cancelada' })
      .eq('colaborador_id', colaborador_id).eq('data_folga', data_folga)
    if (horarios && horarios.length) {
      // Cria bloqueios apenas para os horários NÃO desbloqueados — por ora apenas cancela a folga
    }
    return res.json({ ok: true })
  } catch (err) {
    return res.status(500).json({ erro: 'Erro ao desbloquear agenda' })
  }
})

// ============================================================
// TEMPO DE SERVIÇO POR BARBEIRO
// ============================================================
router.get('/colaboradores/:id/tempos-servico', autenticar, async (req, res) => {
  try {
    const { data } = await supabaseAdmin.from('colaborador_servico_tempo')
      .select('*,servicos(id,nome,duracao_min)').eq('colaborador_id', req.params.id)
    return res.json(data || [])
  } catch (err) {
    return res.status(500).json({ erro: 'Erro ao buscar tempos' })
  }
})

router.post('/colaboradores/:id/tempos-servico', autenticar, ADM_GER, async (req, res) => {
  try {
    const { servico_id, duracao_min } = req.body
    const { data, error } = await supabaseAdmin.from('colaborador_servico_tempo')
      .upsert({ colaborador_id: req.params.id, servico_id, duracao_min, atualizado_em: new Date().toISOString() },
               { onConflict: 'colaborador_id,servico_id' }).select().single()
    if (error) throw error
    return res.json(data)
  } catch (err) {
    return res.status(500).json({ erro: 'Erro ao salvar tempo' })
  }
})

// ============================================================
// GATILHOS DE COMISSÃO
// ============================================================
router.get('/gatilhos-comissao', autenticar, async (req, res) => {
  try {
    const [sv, pd] = await Promise.all([
      supabaseAdmin.from('gatilhos_comissao_servico').select('*').eq('ativo', true).order('faturamento_min'),
      supabaseAdmin.from('gatilhos_comissao_produto').select('*').eq('ativo', true).order('qtd_min')
    ])
    return res.json({ servicos: sv.data || [], produtos: pd.data || [] })
  } catch (err) {
    return res.status(500).json({ erro: 'Erro ao buscar gatilhos' })
  }
})

router.get('/comissao/:colaborador_id', autenticar, async (req, res) => {
  try {
    const { mes } = req.query // formato: YYYY-MM-01
    const mesDate = mes || new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().split('T')[0]
    const { data, error } = await supabaseAdmin.rpc('calcular_comissao', {
      p_colaborador_id: req.params.colaborador_id,
      p_mes: mesDate
    })
    if (error) throw error
    return res.json(data)
  } catch (err) {
    return res.status(500).json({ erro: 'Erro ao calcular comissão' })
  }
})

// ============================================================
// UNIFICAÇÃO DE COMANDAS POR CLIENTE
// ============================================================
router.get('/comandas/cliente/:cliente_id/ativa', autenticar, async (req, res) => {
  try {
    const { data } = await supabaseAdmin.from('comandas')
      .select('*,comanda_itens(*)')
      .eq('cliente_id', req.params.cliente_id)
      .in('status', ['aberta','em_atendimento'])
      .order('criado_em', { ascending: false })
      .limit(1)
      .single()
    return res.json(data || null)
  } catch (err) {
    return res.json(null)
  }
})

router.post('/comandas/:id/unificar', autenticar, async (req, res) => {
  try {
    const { comanda_origem_id } = req.body
    // Move itens da comanda avulsa para a comanda do agendamento
    const { data: itens } = await supabaseAdmin.from('comanda_itens')
      .select('*').eq('comanda_id', comanda_origem_id)
    if (itens && itens.length) {
      await supabaseAdmin.from('comanda_itens').upsert(
        itens.map(i => ({ ...i, id: undefined, comanda_id: req.params.id }))
      )
    }
    // Fecha a comanda avulsa
    await supabaseAdmin.from('comandas').update({ status: 'unificada' }).eq('id', comanda_origem_id)
    return res.json({ ok: true })
  } catch (err) {
    return res.status(500).json({ erro: 'Erro ao unificar comandas' })
  }
})

// ============================================================
// AGENDAMENTOS — múltiplos serviços e acompanhantes
// ============================================================
router.post('/agendamentos', autenticar, async (req, res) => {
  try {
    const { cliente_id, cliente_nome, sem_cadastro, unidade_id } = req.body

    // Aceita formato flat (campos diretos) ou formato itens (array)
    let itens = req.body.itens
    if (!itens || !itens.length) {
      // Tenta montar itens a partir dos campos flat
      const { colaborador_id, servico_id, data_hora_ini, nome_acompanhante } = req.body
      if (!colaborador_id || !servico_id || !unidade_id || !data_hora_ini) {
        return res.status(400).json({ erro: 'Campos obrigatórios: colaborador_id, servico_id, unidade_id, data_hora_ini' })
      }
      itens = [{ colaborador_id, servico_id, data_hora_ini, nome_acompanhante }]
    }

    const inserted = []
    for (const item of itens) {
      // Busca tempo do serviço para esse barbeiro
      const { data: tempo } = await supabaseAdmin.from('colaborador_servico_tempo')
        .select('duracao_min').eq('colaborador_id', item.colaborador_id).eq('servico_id', item.servico_id).single()
      const { data: servico } = await supabaseAdmin.from('servicos').select('duracao_min,valor').eq('id', item.servico_id).single()
      const duracao = tempo?.duracao_min || servico?.duracao_min || 30

      const ini = new Date(item.data_hora_ini)
      const fim = new Date(ini.getTime() + duracao * 60000)

      const { data, error } = await supabaseAdmin.from('agendamentos').insert({
        cliente_id, unidade_id,
        colaborador_id: item.colaborador_id,
        servico_id: item.servico_id,
        data_hora_ini: ini.toISOString(),
        data_hora_fim: fim.toISOString(),
        nome_acompanhante: item.nome_acompanhante || null,
        valor: servico?.valor || 0,
        encaixe: !!(item.encaixe || req.body.encaixe),
        status: 'agendado'
      }).select().single()
      if (error) throw error
      inserted.push(data)
    }
    return res.status(201).json(inserted)
  } catch (err) {
    console.error('[agendamentos]', err)
    return res.status(500).json({ erro: 'Erro ao criar agendamentos' })
  }
})

// Verificar disponibilidade considerando tempo do barbeiro
router.get('/agendamentos/disponibilidade', autenticar, async (req, res) => {
  try {
    const { colaborador_id, servico_id, data } = req.query
    const inicio = data + 'T00:00:00Z'
    const fim    = data + 'T23:59:59Z'

    // Busca agendamentos do dia
    const { data: agends } = await supabaseAdmin.from('agendamentos')
      .select('data_hora_ini,data_hora_fim').eq('colaborador_id', colaborador_id)
      .gte('data_hora_ini', inicio).lte('data_hora_ini', fim)
      .not('status', 'in', '("cancelado","nao_compareceu")')

    // Busca folga do dia
    const { data: folga } = await supabaseAdmin.from('folgas')
      .select('id,periodo').eq('colaborador_id', colaborador_id).eq('data_folga', data)
      .eq('status', 'aprovada').single()

    // Tempo do serviço para esse barbeiro
    const { data: tempo } = await supabaseAdmin.from('colaborador_servico_tempo')
      .select('duracao_min').eq('colaborador_id', colaborador_id).eq('servico_id', servico_id).single()
    const { data: servico } = await supabaseAdmin.from('servicos').select('duracao_min').eq('id', servico_id).single()
    const duracao = tempo?.duracao_min || servico?.duracao_min || 30

    return res.json({
      ocupados: agends || [],
      folga: folga || null,
      duracao_servico: duracao
    })
  } catch (err) {
    return res.status(500).json({ erro: 'Erro ao verificar disponibilidade' })
  }
})

// ============================================================
// CASHBACK — pontos por serviço
// ============================================================
router.post('/cashback/creditar', autenticar, async (req, res) => {
  try {
    const { cliente_id, valor_servicos } = req.body
    const pontos = Math.floor(parseFloat(valor_servicos)) // 1 ponto por R$1

    const { data: carteira } = await supabaseAdmin.from('carteira_pontos')
      .select('id,saldo,total_acumulado').eq('cliente_id', cliente_id).single()

    if (carteira) {
      await supabaseAdmin.from('carteira_pontos').update({
        saldo: carteira.saldo + pontos,
        total_acumulado: carteira.total_acumulado + pontos
      }).eq('id', carteira.id)
    } else {
      await supabaseAdmin.from('carteira_pontos').insert({
        cliente_id, saldo: pontos, total_acumulado: pontos
      })
    }
    return res.json({ pontos_creditados: pontos })
  } catch (err) {
    return res.status(500).json({ erro: 'Erro ao creditar cashback' })
  }
})

router.post('/cashback/resgatar-produto', autenticar, async (req, res) => {
  try {
    const { cliente_id, produto_id } = req.body
    const [carteira, produto] = await Promise.all([
      supabaseAdmin.from('carteira_pontos').select('id,saldo').eq('cliente_id', cliente_id).single(),
      supabaseAdmin.from('produtos').select('nome,pontos_resgate').eq('id', produto_id).single()
    ])
    if (!carteira.data || !produto.data) return res.status(404).json({ erro: 'Cliente ou produto não encontrado' })
    if (!produto.data.pontos_resgate) return res.status(400).json({ erro: 'Produto não tem pontos configurados' })
    if (carteira.data.saldo < produto.data.pontos_resgate) return res.status(400).json({ erro: 'Saldo insuficiente' })

    await supabaseAdmin.from('carteira_pontos').update({
      saldo: carteira.data.saldo - produto.data.pontos_resgate
    }).eq('id', carteira.data.id)

    return res.json({ ok: true, pontos_usados: produto.data.pontos_resgate, saldo_restante: carteira.data.saldo - produto.data.pontos_resgate })
  } catch (err) {
    return res.status(500).json({ erro: 'Erro ao resgatar produto' })
  }
})

// ============================================================
// ROTAS EXISTENTES MANTIDAS
// ============================================================

// DELETE /agendamentos/:id — remover agendamento (bloqueio)
router.delete('/agendamentos/:id', autenticar, async (req, res) => {
  try {
    const { error } = await supabaseAdmin
      .from('agendamentos').delete().eq('id', req.params.id)
    if (error) throw error
    return res.status(200).json({ ok: true })
  } catch (err) {
    console.error('[DELETE agendamento]', err.message)
    return res.status(500).json({ erro: err.message })
  }
})

// PATCH /agendamentos/:id — atualizar status (cancelar, etc)
router.patch('/agendamentos/:id', autenticar, async (req, res) => {
  try {
    const { status } = req.body
    const { data, error } = await supabaseAdmin
      .from('agendamentos').update({ status }).eq('id', req.params.id).select().single()
    if (error) throw error
    return res.json(data)
  } catch (err) {
    console.error('[PATCH agendamento]', err.message)
    return res.status(500).json({ erro: err.message })
  }
})

// POST /agendamentos/:id/reabrir-autorizado — reabre um atendimento concluído.
// Gestor logado autoriza sozinho; caixa precisa da senha de autorização.
router.post('/agendamentos/:id/reabrir-autorizado', autenticar, async (req, res) => {
  try {
    let autorizador = null
    if (['gerente', 'proprietario'].includes(req.usuario.perfil)) {
      autorizador = { id: req.usuario.id, nome: req.usuario.nome }
    } else {
      autorizador = await validarSenhaAutorizacao(req.body.senha)
      if (!autorizador) return res.status(403).json({ erro: 'Senha de autorização inválida.' })
    }
    const { data, error } = await supabaseAdmin
      .from('agendamentos').update({ status: 'agendado' }).eq('id', req.params.id).select().single()
    if (error) throw error
    return res.json({ ok: true, autorizado_por: autorizador.nome })
  } catch (err) {
    console.error('[reabrir-autorizado]', err.message)
    return res.status(500).json({ erro: 'Erro ao reabrir atendimento' })
  }
})

// POST /agendamentos/:id/finalizar — conclui o atendimento E grava o detalhe dos itens
// (serviço/produto + quantidade) numa comanda ligada, para a comissão por faixa.
// O faturamento continua contando por agendamento.valor (comanda fica com agendamento_id → não duplica).
// O registro dos itens é "best-effort": se falhar, a venda mesmo assim é concluída.
router.post('/agendamentos/:id/finalizar', autenticar, async (req, res) => {
  try {
    const { forma_pgto, desconto = 0, itens } = req.body || {}
    const { data: ag, error: e0 } = await supabaseAdmin
      .from('agendamentos').select('id, colaborador_id, unidade_id, cliente_id').eq('id', req.params.id).single()
    if (e0 || !ag) return res.status(404).json({ erro: 'Agendamento não encontrado' })

    const lista = Array.isArray(itens) ? itens : []
    const subtotal = lista.reduce((s, it) => s + (parseFloat(it.valor != null ? it.valor : it.valor_unit) || 0) * (parseInt(it.quantidade) || 1), 0)
    const total = Math.max(0, subtotal - parseFloat(desconto || 0))

    // 1) conclui o agendamento — GUARDA ATÔMICA contra duplo-clique:
    //    só finaliza se ainda NÃO está concluído (evita criar comanda 2x).
    const { data: flip, error: eflip } = await supabaseAdmin.from('agendamentos')
      .update({ status: 'concluido', valor: total, forma_pagamento: forma_pgto || null })
      .eq('id', ag.id).neq('status', 'concluido').select('id')
    if (eflip) throw eflip
    if (!flip || !flip.length) return res.status(400).json({ erro: 'Este atendimento já foi finalizado' })

    // 2) grava o detalhe numa comanda ligada ao agendamento (best-effort)
    let comanda_id = null
    try {
      if (lista.length) {
        const { data: cm } = await supabaseAdmin.from('comandas').insert({
          agendamento_id: ag.id, cliente_id: ag.cliente_id || null,
          colaborador_id: ag.colaborador_id, unidade_id: ag.unidade_id,
          status: 'finalizada', forma_pgto: normalizarForma(forma_pgto),
          subtotal, desconto, total,
          aberta_em: new Date().toISOString(), finalizada_em: new Date().toISOString(),
          observacao: 'Finalização de atendimento', criado_por: req.usuario.id
        }).select().single()
        if (cm) {
          comanda_id = cm.id
          for (const it of lista) {
            const tipo = (String(it.tipo || '').toLowerCase().indexOf('produto') !== -1) ? 'produto' : 'servico'
            const qtd = parseInt(it.quantidade) || 1
            const valor_unit = parseFloat(it.valor != null ? it.valor : it.valor_unit) || 0
            await supabaseAdmin.from('itens_comanda').insert({
              comanda_id: cm.id, tipo, servico_id: it.servico_id || null, produto_id: it.produto_id || null,
              descricao: it.nome || it.descricao || (tipo === 'produto' ? 'Produto' : 'Serviço'),
              quantidade: qtd, valor_unit
            })
            if (tipo === 'produto' && it.produto_id) {
              await supabaseAdmin.from('movimentacoes_estoque').insert({
                produto_id: it.produto_id, unidade_id: ag.unidade_id, tipo: 'saida_venda',
                quantidade: qtd, responsavel_id: ag.colaborador_id, referencia_id: cm.id
              }).then(() => {}).catch(() => {})
            }
          }
        }
      }
    } catch (eItens) { console.error('[finalizar itens]', eItens.message) }

    return res.json({ ok: true, agendamento_id: ag.id, comanda_id, total })
  } catch (err) {
    console.error('[agendamentos/finalizar]', err.message)
    return res.status(500).json({ erro: err.message || 'Erro ao finalizar' })
  }
})

// POST /agendamentos/bloquear — bloqueia a agenda em blocos de 30 min
// Cria UM bloqueio por slot (30 min) entre ini e fim, para que cada horário
// possa ser desbloqueado individualmente. Pula slots que já têm cliente/bloqueio.
router.post('/agendamentos/bloquear', autenticar, async (req, res) => {
  try {
    const { colaborador_id, data_hora_ini, data_hora_fim } = req.body
    if (!colaborador_id || !data_hora_ini || !data_hora_fim) {
      return res.status(400).json({ erro: 'colaborador_id, data_hora_ini e data_hora_fim são obrigatórios' })
    }

    // Unidade do colaborador
    const { data: colab } = await supabaseAdmin
      .from('colaboradores').select('unidade_id').eq('id', colaborador_id).single()
    const unidade_id = colab?.unidade_id || null

    // Serviço qualquer (ativo) só para satisfazer NOT NULL
    const { data: servico } = await supabaseAdmin
      .from('servicos').select('id').eq('ativo', true).limit(1).single()
    if (!servico) return res.status(400).json({ erro: 'Nenhum serviço cadastrado para usar como bloqueio' })

    const ini = new Date(data_hora_ini)
    const fim = new Date(data_hora_fim)
    const STEP_MS = 30 * 60 * 1000
    if (!(fim.getTime() > ini.getTime())) return res.status(400).json({ erro: 'Período inválido' })

    // O que já existe nesse intervalo (não duplica e não atropela cliente)
    const { data: existentes } = await supabaseAdmin
      .from('agendamentos')
      .select('data_hora_ini,data_hora_fim,status')
      .eq('colaborador_id', colaborador_id)
      .gte('data_hora_ini', new Date(ini.getTime() - STEP_MS).toISOString())
      .lt('data_hora_ini', fim.toISOString())
      .not('status', 'eq', 'cancelado')

    function ocupado(t) {
      return (existentes || []).some(function (a) {
        const s = new Date(a.data_hora_ini).getTime()
        const e = a.data_hora_fim ? new Date(a.data_hora_fim).getTime() : s + STEP_MS
        return s < t + STEP_MS && e > t // sobreposição
      })
    }

    const linhas = []
    let pulados = 0
    for (let t = ini.getTime(); t < fim.getTime(); t += STEP_MS) {
      if (ocupado(t)) { pulados++; continue }
      linhas.push({
        colaborador_id,
        unidade_id,
        servico_id: servico.id,
        data_hora_ini: new Date(t).toISOString(),
        data_hora_fim: new Date(t + STEP_MS).toISOString(),
        status: 'bloqueado',
        valor: 0
      })
    }

    if (!linhas.length) {
      return res.status(200).json({ ok: true, criados: 0, pulados, msg: 'Todos os horários já estavam ocupados' })
    }

    const { data, error } = await supabaseAdmin.from('agendamentos').insert(linhas).select('id')
    if (error) throw error
    return res.status(201).json({ ok: true, criados: data.length, pulados })
  } catch (err) {
    console.error('[bloquear]', err.message)
    return res.status(500).json({ erro: err.message || 'Erro ao bloquear' })
  }
})

// POST /colaboradores — criar novo colaborador
router.post('/colaboradores', autenticar, ADM_GER, async (req, res) => {
  try {
    const { nome, email, whatsapp, perfil, ativo, data_nasc, comissao_pct } = req.body
    if (!nome || !email) return res.status(400).json({ erro: 'Nome e email são obrigatórios' })
    const payload = { nome, email, perfil: perfil||'colaborador', ativo: ativo!==false }
    if (whatsapp)    payload.whatsapp    = whatsapp
    if (data_nasc)   payload.data_nasc   = data_nasc
    if (comissao_pct) payload.comissao_pct = parseFloat(comissao_pct)
    const { data, error } = await supabaseAdmin.from('colaboradores').insert(payload).select().single()
    if (error) { console.error('[POST colaboradores]', error); throw error }
    return res.status(201).json(data)
  } catch (err) {
    console.error('[POST colaboradores] catch:', err.message || err)
    return res.status(500).json({ erro: err.message || 'Erro ao criar colaborador' })
  }
})

// PUT /colaboradores/:id — atualizar colaborador
router.put('/colaboradores/:id', autenticar, ADM_GER, async (req, res) => {
  try {
    const { nome, email, whatsapp, perfil, ativo, data_nasc, comissao_pct } = req.body
    const payload = {}
    if (nome)        payload.nome        = nome
    if (email)       payload.email       = email
    if (whatsapp)    payload.whatsapp    = whatsapp
    if (perfil)      payload.perfil      = perfil
    if (ativo !== undefined) payload.ativo = ativo
    if (data_nasc)   payload.data_nasc   = data_nasc
    if (comissao_pct) payload.comissao_pct = parseFloat(comissao_pct)
    const { data, error } = await supabaseAdmin.from('colaboradores')
      .update(payload).eq('id', req.params.id).select().single()
    if (error) { console.error('[PUT colaboradores]', error); throw error }
    return res.json(data)
  } catch (err) {
    console.error('[PUT colaboradores] catch:', err.message || err)
    return res.status(500).json({ erro: err.message || 'Erro ao atualizar colaborador' })
  }
})

// GET /dashboard/agenda-dia — agenda de qualquer data (estrutura flat)
router.get('/dashboard/agenda-dia', autenticar, async (req, res) => {
  try {
    const { data } = req.query
    const dia = data || new Date().toLocaleString('en-CA', { timeZone: 'America/Sao_Paulo' }).split(',')[0]

    const perfil = req.usuario.perfil
    const unidadeId = req.usuario.unidade_id

    let q = supabaseAdmin.from('vw_agenda_dia')
      .select('id,data_hora_ini,data_hora_fim,status,valor,colaborador_id,colaborador_nome,unidade_id,unidade_nome,cliente_nome,servico_nome,duracao_min,canal_origem')
      .gte('data_hora_ini', dia + 'T00:00:00-03:00')
      .lte('data_hora_ini', dia + 'T23:59:59-03:00')
      .not('status', 'eq', 'cancelado')
      .order('data_hora_ini')

    // Gerente e barbeiro veem APENAS a própria unidade (com todos os barbeiros dela).
    // O "apenas minha agenda" é um filtro visual na tela. Proprietário/caixa veem tudo.
    if ((perfil === 'gerente' || perfil === 'colaborador') && unidadeId) {
      q = q.eq('unidade_id', unidadeId)
    }

    const { data: agenda, error } = await q
    if(error) throw error

    // Busca o flag "encaixe" direto da tabela (a view pode não expor) e monta um Set.
    const ids = (agenda || []).map(a => a.id).filter(Boolean)
    const encaixeSet = new Set()
    if (ids.length) {
      const { data: encs } = await supabaseAdmin
        .from('agendamentos').select('id').eq('encaixe', true).in('id', ids)
      ;(encs || []).forEach(e => encaixeSet.add(e.id))
    }

    const flat = (agenda || []).map(a => ({
      id:               a.id,
      data_hora_ini:    a.data_hora_ini,
      data_hora_fim:    a.data_hora_fim,
      status:           a.status,
      valor:            a.valor,
      colaborador_id:   a.colaborador_id,
      colaborador_nome: a.colaborador_nome || null,
      unidade_nome:     a.unidade_nome || null,
      cliente_nome:     a.cliente_nome || null,
      servico_nome:     a.servico_nome || null,
      duracao_min:      a.duracao_min || 30,
      canal_origem:     a.canal_origem || null,
      encaixe:          encaixeSet.has(a.id)
    }))

    return res.json(flat)
  } catch(err) {
    console.error('[agenda-dia]', err.message)
    return res.status(500).json({ erro: 'Erro ao buscar agenda' })
  }
})

// GET /unidades
router.get('/unidades', autenticar, async (req, res) => {
  try {
    const { data } = await supabaseAdmin.from('unidades').select('id,nome').order('nome')
    return res.json(data || [])
  } catch (err) { return res.status(500).json({ erro: 'Erro' }) }
})

router.get('/servicos', autenticar, async (req, res) => {
  try {
    const { data } = await supabaseAdmin.from('servicos').select('*').eq('ativo', true).order('nome')
    return res.json(data || [])
  } catch (err) { return res.status(500).json({ erro: 'Erro' }) }
})

router.get('/produtos', autenticar, async (req, res) => {
  try {
    const { data } = await supabaseAdmin.from('produtos').select('*').eq('ativo', true).order('nome')
    return res.json(data || [])
  } catch (err) { return res.status(500).json({ erro: 'Erro' }) }
})

router.get('/colaboradores-todos', autenticar, TODOS, async (req, res) => {
  try {
    const { data } = await supabaseAdmin.from('colaboradores').select('id,nome,email,whatsapp,perfil,comissao_pct,foto_url,foto_url_2,ativo,unidade_id,unidades(nome)').eq('ativo', true).order('nome')
    return res.json(data || [])
  } catch (err) { return res.status(500).json({ erro: 'Erro' }) }
})

router.get('/clientes', autenticar, async (req, res) => {
  try {
    const limit  = parseInt(req.query.limit) || 50
    const offset = parseInt(req.query.offset) || 0
    const busca  = (req.query.q || '').trim()

    console.log('[clientes] busca=', busca, 'limit=', limit)

    let q = supabaseAdmin
      .from('clientes')
      .select('id,nome,email,whatsapp,cpf,ativo,carteira_pontos(saldo)')
      .eq('ativo', true)
      .order('nome')

    if (busca && busca.length >= 2) {
      q = q.or(`nome.ilike.%${busca}%,whatsapp.ilike.%${busca}%`)
    }

    q = q.range(offset, offset + limit - 1)

    const { data, error } = await q
    if (error) throw error
    console.log('[clientes] retornando', data ? data.length : 0, 'resultados')
    return res.json(data || [])
  } catch (err) {
    console.error('[clientes]', err.message)
    return res.status(500).json({ erro: 'Erro ao buscar clientes' })
  }
})

router.get('/colaboradores', autenticar, async (req, res) => {
  try {
    const { unidade_id } = req.query
    let q = supabaseAdmin.from('colaboradores').select('id,nome,perfil,unidade_id').eq('ativo', true).in('perfil', ['colaborador','gerente']).order('nome')
    if (unidade_id) q = q.eq('unidade_id', unidade_id)
    const { data } = await q
    return res.json(data || [])
  } catch (err) { return res.status(500).json({ erro: 'Erro' }) }
})

// PUT /agendamentos/mover
router.put('/agendamentos/mover', autenticar, ADM_GER, async (req, res) => {
  try {
    const { agendamento_id, novo_horario, novo_colaborador_id, nova_unidade_id } = req.body
    const updates = {}
    if (novo_horario)        updates.data_hora_ini = novo_horario
    if (novo_colaborador_id) updates.colaborador_id = novo_colaborador_id
    if (nova_unidade_id)     updates.unidade_id = nova_unidade_id
    const { data, error } = await supabaseAdmin.from('agendamentos').update(updates).eq('id', agendamento_id).select().single()
    if (error) throw error
    return res.json(data)
  } catch (err) { return res.status(500).json({ erro: 'Erro ao mover agendamento' }) }
})

// GET /agenda/folgas-hoje
router.get('/agenda/folgas-hoje', autenticar, async (req, res) => {
  try {
    const { unidade_id } = req.query
    const hoje = new Date().toISOString().split('T')[0]
    let q = supabaseAdmin.from('folgas').select('colaborador_id,periodo,colaboradores(id,nome)').eq('data_folga', hoje).eq('status', 'aprovada')
    if (unidade_id) q = q.eq('unidade_id', unidade_id)
    const { data } = await q
    return res.json(data || [])
  } catch (err) { return res.status(500).json({ erro: 'Erro' }) }
})

router.get('/colaboradores-todos', autenticar, TODOS, async (req, res) => {
  try {
    const { data } = await supabaseAdmin.from('colaboradores').select('id,nome,email,whatsapp,perfil,comissao_pct,saldo_vales_pix,foto_url,foto_url_2,ativo,unidade_id,unidades(nome)').eq('ativo', true).order('nome')
    return res.json(data || [])
  } catch (err) { return res.status(500).json({ erro: 'Erro' }) }
})

module.exports = router
