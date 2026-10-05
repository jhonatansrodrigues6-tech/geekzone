# GeekZone

Loja local em HTML/CSS/JavaScript com backend Node.js para contas, pedidos,
solicitacoes de troca/devolucao, frete gratis nacional e pagamento Pix direto.

## Executar localmente

Requer Node.js 22 ou superior.

```powershell
npm install
Copy-Item .env.example .env
```

Edite `.env` e defina `SESSION_SECRET` e `ADMIN_API_KEY` com valores aleatorios
longos. Depois inicie a loja:

```powershell
npm start
```

Acesse `http://localhost:3000`. Nao abra `index.html` diretamente como arquivo:
o checkout e as contas dependem da API local.

## Configurar Pix direto

Preencha no `.env`:

- `PIX_KEY`: chave Pix da conta que recebera o pagamento (CPF/CNPJ, e-mail,
  telefone ou chave aleatoria).
- `PIX_MERCHANT_NAME`: nome do recebedor, com ate 25 caracteres.
- `PIX_MERCHANT_CITY`: cidade do recebedor, com ate 15 caracteres.

O servidor gera localmente o BR Code com o valor exato do pedido e um QR Code
PNG. O pagamento e enviado pelo banco do comprador diretamente para a chave
configurada; a loja nao usa Mercado Pago nem oferece pagamento com cartao.
Nunca coloque a chave Pix ou `ADMIN_API_KEY` no JavaScript, nem compartilhe
esses dados em repositorios publicos.

**A confirmacao e manual:** um Pix direto para uma chave nao fornece a esta
loja acesso ao extrato bancario ou notificacoes de liquidacao. O pedido fica
pendente ate que a loja confira no proprio banco se o valor foi creditado.
Somente depois dessa verificacao, um administrador pode confirmar o pedido:

```powershell
Invoke-RestMethod -Method Post `
  -Uri "http://localhost:3000/api/admin/orders/ID_DO_PEDIDO/payment/confirm" `
  -Headers @{ Authorization = "Bearer SUA_ADMIN_API_KEY" }
```

Use o ID interno retornado ao criar o pedido (nao o codigo publico `GZ-...`).
Em producao, proteja esse endpoint com HTTPS e mantenha a chave administrativa
somente em uma ferramenta administrativa confiavel. Nao confirme pedidos com
base em comprovantes enviados pelo cliente; valide o credito no extrato.

## Frete

`https://api.correios.com.br/preco/v1` e a base da API, nao uma URL completa
para abrir no navegador. O servidor chama a rota de produto
`/preco/v1/nacional/{codigoServico}` com os parametros do pacote e um token
obtido no CWS. O endpoint exige contrato ativo, autenticacao e servicos
habilitados; um 403 normalmente indica acesso/servico nao autorizado, nao que
a URL base deva ser aberta diretamente.

Por padrao, o checkout oferece **frete gratis para todos os estados do Brasil**
(`SHIPPING_MODE=free`), sem depender das credenciais dos Correios.

Se quiser mudar essa regra futuramente, `SHIPPING_MODE=fixed` usa uma tarifa e
prazo configurados pela loja (`SHIPPING_FLAT_RATE_CENTS` e
`SHIPPING_FLAT_RATE_DAYS`), e `SHIPPING_MODE=correios` usa a API dos Correios.
Para o modo Correios, o contrato precisa habilitar as APIs de token, preco e
prazo. Configure usuario, codigo de acesso, cartao de postagem, CEP de origem,
codigos de servico e dimensoes reais da embalagem; o peso usa
`CORREIOS_ITEM_WEIGHT_GRAMS`.

## Contas, pedidos e privacidade

As contas, sessoes, pedidos e solicitacoes de troca/devolucao ficam em SQLite
local no diretorio `data/`, que nao e servido publicamente. Senhas sao
armazenadas como hashes. Para producao, use HTTPS, mantenha as chaves fora do
repositorio, configure backups protegidos para `data/` e restrinja a chave
administrativa.

Pedidos precisam ser autenticados pela conta do cliente. O endpoint
administrativo de expedicao aceita `ADMIN_API_KEY` no cabecalho
`Authorization: Bearer ...` para atualizar o status e o codigo de rastreio.
Esse segredo deve ser usado apenas por um painel administrativo confiavel,
nunca incluido no JavaScript da loja.

## Endpoints principais

- `GET /api/session`: sessao atual e token CSRF.
- `POST /api/auth/register`, `POST /api/auth/login`, `POST /api/auth/logout`.
- `POST /api/shipping/quotes`: frete gratis nacional, Correios ou frete fixo.
- `POST /api/checkout`: cria pedido e retorna QR Code Pix direto, se os tres
  valores `PIX_*` estiverem configurados.
- `GET /api/orders`: pedidos da conta autenticada.
- `GET /api/orders/:id/payment`: recupera o QR Code Pix pendente da conta.
- `GET /api/orders/:id/payment-status`: consulta o estado registrado pela loja;
  nao consulta o banco automaticamente.
- `POST /api/admin/orders/:id/payment/confirm`: confirma manualmente um Pix
  pendente depois da verificacao bancaria.
- `POST /api/orders/:id/returns`: registra solicitacao para analise.
- `PATCH /api/admin/orders/:id/shipping`: expedicao e rastreio (administrativo).
