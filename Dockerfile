# 純靜態網站，用官方 nginx 提供 web/ 目錄即可
FROM nginx:1.27-alpine

COPY web/ /usr/share/nginx/html/
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s \
  CMD wget -qO- http://localhost/ >/dev/null 2>&1 || exit 1
