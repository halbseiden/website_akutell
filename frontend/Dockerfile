FROM nginx:1.31.6-alpine

# Gepatchte Alpine-Systempakete (z. B. libexpat, pcre2) einspielen, auch
# wenn das Base-Image selbst noch nicht neu gebaut wurde.
RUN apk upgrade --no-cache

# Statische Dateien in das Standard-Webroot von Nginx kopieren.
# Nginx serviert /usr/share/nginx/html ueber den vorkonfigurierten
# Default-Server auf Port 80 - keine eigene nginx.conf noetig.
COPY html/ /usr/share/nginx/html/

EXPOSE 80
