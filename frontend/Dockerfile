FROM nginxinc/nginx-unprivileged:1.27-alpine

# Root only for the copy + chmod (the entrypoint ignores scripts that are not executable, and the
# executable bit is lost when files travel through zip files or Windows), then back to the nginx user.
USER root
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY origin.conf /etc/nginx/conf.d/00-origin.conf
COPY 15-resolver.sh /docker-entrypoint.d/15-resolver.sh
RUN chmod 0755 /docker-entrypoint.d/15-resolver.sh
COPY public/ /usr/share/nginx/html/
USER 101

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
