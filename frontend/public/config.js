// Runtime configuration. In Kubernetes this file is replaced by a ConfigMap that the pipeline fills in.
//   API_BASE_URL       the API service (in Kubernetes: "/api", proxied by nginx)
//   PAYMENTS_API_URL   API Gateway + Lambda for money movement (optional: defaults to API_BASE_URL)
window.APP_CONFIG = {
  API_BASE_URL: "http://localhost:3000",
};
