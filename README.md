# Serviço de Chat de Áudio

Serviço WebSocket para gerenciamento de chat de áudio usando WebRTC.

## Requisitos

- Node.js >= 14.0.0
- NPM ou Yarn

## Configuração

1. Clone o repositório
2. Instale as dependências:

```bash
npm install
```

3. Configure as variáveis de ambiente no arquivo `.env`:

```env
PORT=3001
NODE_ENV=production
CORS_ORIGIN=https://seu-dominio.com
MAX_USERS_PER_ROOM=10
ROOM_TIMEOUT=3600000
```

## Deploy

### Usando PM2 (Recomendado)

1. Instale o PM2 globalmente:

```bash
npm install -g pm2
```

2. Inicie o serviço:

```bash
pm2 start server.js --name audio-chat
```

3. Configure o PM2 para iniciar automaticamente:

```bash
pm2 startup
pm2 save
```

### Usando Docker

1. Construa a imagem:

```bash
docker build -t audio-chat-service .
```

2. Execute o container:

```bash
docker run -d \
  --name audio-chat \
  -p 3001:3001 \
  --env-file .env \
  audio-chat-service
```

## Monitoramento

### PM2

```bash
# Ver status
pm2 status

# Ver logs
pm2 logs audio-chat

# Reiniciar serviço
pm2 restart audio-chat
```

### Docker

```bash
# Ver logs
docker logs audio-chat

# Reiniciar container
docker restart audio-chat
```

## Endpoints

- `GET /status` - Status do servidor
- `GET /health` - Health check

## WebSocket Events

### Cliente -> Servidor

- `join-room` - Entrar em uma sala
- `leave-room` - Sair de uma sala
- `ice-candidate` - Enviar candidato ICE
- `offer` - Enviar oferta WebRTC
- `answer` - Enviar resposta WebRTC

### Servidor -> Cliente

- `user-joined` - Novo usuário entrou
- `user-left` - Usuário saiu
- `ice-candidate` - Receber candidato ICE
- `offer` - Receber oferta WebRTC
- `answer` - Receber resposta WebRTC

## Troubleshooting

1. Verifique os logs do servidor para erros
2. Confirme se as portas necessárias estão abertas
3. Verifique se as variáveis de ambiente estão configuradas corretamente
4. Teste a conectividade WebSocket usando ferramentas como wscat

## Suporte

Para reportar problemas ou solicitar ajuda, abra uma issue no repositório.
