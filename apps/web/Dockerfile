# Phase 0 web service: nginx serving the static bilingual placeholder.
# In Phase 1 this stage builds the Angular panel (dist/) into nginx instead;
# the compose service definition stays identical.
FROM nginx:1.27-alpine
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY apps/web/public/ /usr/share/nginx/html/
EXPOSE 80
HEALTHCHECK --interval=10s --timeout=3s --retries=5 \
  CMD wget -q -O /dev/null http://127.0.0.1/ || exit 1
