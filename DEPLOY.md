# Deployment Guide

## Prerequisites

- Ubuntu Server 22.04 VPS
- Domain pointing to the server IP
- GitHub repository access

---

## 1. Server Setup

```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Install dependencies
sudo apt install -y unzip curl nginx certbot python3-certbot-nginx git

# Install Bun
curl -fsSL https://bun.sh/install | bash
source ~/.bashrc

# Install PM2 globally via Bun
bun install -g pm2
```

## 2. Deploy Application

```bash
# Create directory
sudo mkdir -p /var/www/wilcraft-store
sudo chown $USER:$USER /var/www/wilcraft-store

# Clone repository
git clone https://github.com/bagaslabs/wilcraft-store.git /var/www/wilcraft-store

# Install dependencies
cd /var/www/wilcraft-store
bun install

# Create environment file
cp .env.example .env
nano .env   # Fill in all required variables
```

## 3. Environment Variables

Fill in `.env` with your values:

| Variable | Description |
|----------|-------------|
| `DISCORD_TOKEN` | Discord bot token |
| `DISCORD_CLIENT_ID` | Discord application client ID |
| `DISCORD_GUILD_ID` | Discord server ID |
| `LIVE_STOCK_CHANNEL_ID` | Channel ID for stock panel |
| `ADMIN_CHANNEL_ID` | Channel ID for admin logs |
| `BUY_LOG_CHANNEL_ID` | Channel ID for purchase logs |
| `DEPOSIT_LOG_CHANNEL_ID` | Channel ID for deposit logs |
| `ADMIN_ROLE_IDS` | Comma-separated admin role IDs |
| `PURCHASE_ROLE_IDS` | Comma-separated purchaser role IDs |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key |
| `MIDTRANS_SERVER_KEY` | Midtrans server key (optional) |
| `GROWTOPIA_DEPOSIT_TOKEN` | Token for Growtopia webhook (optional) |

## 4. Nginx Configuration

Create `/etc/nginx/sites-available/wilcraft-store`:

```nginx
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
```

Enable the site:

```bash
sudo ln -s /etc/nginx/sites-available/wilcraft-store /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

## 5. SSL Certificate (Certbot)

```bash
sudo certbot --nginx -d your-domain.com
```

This will automatically update the Nginx config and enable HTTPS.

## 6. PM2 Process Manager

```bash
cd /var/www/wilcraft-store

# Start the application
pm2 start src/main.ts --interpreter $(which bun) --name wilcraft-store

# Save PM2 process list
pm2 save

# Enable PM2 to start on boot
pm2 startup
```

## 7. Useful Commands

```bash
# View logs
pm2 logs wilcraft-store

# Monitor
pm2 monit

# Restart
pm2 restart wilcraft-store

# Stop
pm2 stop wilcraft-store
```

## 8. Database Migrations

Apply Supabase migrations through the Supabase dashboard SQL editor, or use the Supabase CLI:

```bash
# Install Supabase CLI
bun install -g supabase

# Link project
supabase link --project-ref your-project-ref

# Apply migrations
supabase db push
```

---

## GitHub Actions — Automatic Deployment

Create `.github/workflows/deploy.yml`:

```yaml
name: Deploy

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Deploy to VPS
        uses: appleboy/ssh-action@v1.2.0
        with:
          host: ${{ secrets.VPS_HOST }}
          username: ${{ secrets.VPS_USER }}
          key: ${{ secrets.VPS_SSH_KEY }}
          script: |
            set -e

            cd /var/www/wilcraft-store

            git pull origin main

            /home/${{ secrets.VPS_USER }}/.bun/bin/bun install

            /home/${{ secrets.VPS_USER }}/.bun/bin/pm2 restart wilcraft-store
```

### GitHub Secrets

Add these secrets to your GitHub repository (Settings → Secrets and variables → Actions):

| Secret | Value |
|--------|-------|
| `VPS_HOST` | Your VPS IP address |
| `VPS_USER` | SSH username |
| `VPS_SSH_KEY` | Private SSH key for deployment |

---

## Verify Deployment

```bash
# Check PM2 status
pm2 status

# Check application
curl http://127.0.0.1:3000/health

# Check Nginx
sudo nginx -t
sudo systemctl status nginx

# Verify HTTPS
curl https://your-domain.com/health
```
