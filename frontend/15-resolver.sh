#!/bin/sh
# Tells nginx which DNS server to use for names it resolves at request time (the Grafana Service).
# Inside Kubernetes this is the cluster DNS from /etc/resolv.conf. Elsewhere it is simply not needed.
ns="$(awk '/^nameserver/ { print $2; exit }' /etc/resolv.conf)"
if [ -n "$ns" ]; then
  echo "resolver $ns valid=10s ipv6=off;" > /tmp/nginx-resolver.conf
fi
