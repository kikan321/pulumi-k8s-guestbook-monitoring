// Copyright 2016-2025, Pulumi Corporation.  All rights reserved.

import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

// Minikube does not implement services of type `LoadBalancer`; require the user to specify if we're
// running on minikube, and if so, create only services of type ClusterIP.
const config = new pulumi.Config();
const isMinikube = config.getBoolean("isMinikube");

//
// REDIS LEADER.
//

const redisLeaderLabels = { app: "redis-leader" };
const redisLeaderDeployment = new k8s.apps.v1.Deployment("redis-leader", {
    spec: {
        selector: { matchLabels: redisLeaderLabels },
        template: {
            metadata: { labels: redisLeaderLabels },
            spec: {
                containers: [
                    {
                        name: "redis-leader",
                        image: "redis",
                        resources: { requests: { cpu: "100m", memory: "100Mi" } },
                        ports: [{
                             containerPort: 6379 
                        }],
                    },


                    {
                        name: "redis-exporter",
                        image: "oliver006/redis_exporter:v1.55.0", 
                        ports: [{ name: "redis-metrics", containerPort: 9121 }],
                        resources: { requests: { cpu: "50m", memory: "50Mi" } },
                    }


                ],
            },
        },
    },
});
const redisLeaderService = new k8s.core.v1.Service("redis-leader", {
    metadata: {
        name: "redis-leader",
        labels: redisLeaderDeployment.spec.template.metadata.labels,
    },
    spec: {
        ports: [
            { name: "redis-port", port: 6379, targetPort: 6379 },
            { name: "metrics-port", port: 9121, targetPort: 9121 }
        ],
        selector: redisLeaderDeployment.spec.template.metadata.labels,
    },
});

//
// REDIS REPLICA.
//

const redisReplicaLabels = { app: "redis-replica" };
const redisReplicaDeployment = new k8s.apps.v1.Deployment("redis-replica", {
    spec: {
        selector: { matchLabels: redisReplicaLabels },
        template: {
            metadata: { labels: redisReplicaLabels },
            spec: {
                containers: [
                    {
                        name: "replica",
                        image: "pulumi/guestbook-redis-replica",
                        resources: { requests: { cpu: "100m", memory: "100Mi" } },
                        // If your cluster config does not include a dns service, then to instead access an environment
                        // variable to find the leader's host, change `value: "dns"` to read `value: "env"`.
                        env: [{ name: "GET_HOSTS_FROM", value: "dns" }],
                        ports: [{ containerPort: 6379 }],
                    },


                    {
                        name: "redis-exporter",
                        image: "oliver006/redis_exporter:v1.55.0",
                        ports: [{ name: "redis-metrics", containerPort: 9121 }],
                        resources: { requests: { cpu: "50m", memory: "50Mi" } },
                    }




                ],
            },
        },
    },
});
const redisReplicaService = new k8s.core.v1.Service("redis-replica", {
    metadata: {
        name: "redis-replica",
        labels: redisReplicaDeployment.spec.template.metadata.labels,
    },
    spec: {
        ports: [
            { name: "redis-port", port: 6379, targetPort: 6379 },
            { name: "metrics-port", port: 9121, targetPort: 9121 }           
        ],
        selector: redisReplicaDeployment.spec.template.metadata.labels,
    },
});

//
// FRONTEND
//

const frontendLabels = { app: "frontend" };
const frontendDeployment = new k8s.apps.v1.Deployment("frontend", {
    spec: {
        selector: { matchLabels: frontendLabels },
        replicas: 3,
        template: {
            metadata: { labels: frontendLabels },
            spec: {
                containers: [
                    {
                        name: "frontend",
                        image: "pulumi/guestbook-php-redis",
                        resources: { requests: { cpu: "100m", memory: "100Mi" } },
                        // If your cluster config does not include a dns service, then to instead access an environment
                        // variable to find the master service's host, change `value: "dns"` to read `value: "env"`.
                        env: [{ name: "GET_HOSTS_FROM", value: "dns" /* value: "env"*/ }],
                        ports: [{ containerPort: 80 }],
                    },


                    {
                        name: "apache-exporter",
                        image: "lusotycoon/apache-exporter:v0.11.0",
                        args: ["--scrape_uri", "http://localhost:80/server-status?auto"],
                        ports: [{ name: "metrics", containerPort: 9117 }],
                        resources: { requests: { cpu: "50m", memory: "50Mi" } },
                    }



                ],
            },
        },
    },
});
const frontendService = new k8s.core.v1.Service("frontend", {
    metadata: {
        labels: frontendDeployment.spec.template.metadata.labels,
        name: "frontend",
    },
    spec: {
        type: isMinikube ? "ClusterIP" : "LoadBalancer",
        ports: [
            { name: "http", port: 80, targetPort: 80 },
            { name: "metrics-port", port: 9117, targetPort: 9117 }             
        ],
        selector: frontendDeployment.spec.template.metadata.labels,
    },
});

// Export the frontend IP.
export let frontendIp: pulumi.Output<string>;
if (isMinikube) {
    frontendIp = frontendService.spec.clusterIP;
} else {
    frontendIp = frontendService.status.loadBalancer.ingress[0].ip;
}


// observability section

// Monitoring namespace
const monitoringNamespace = new k8s.core.v1.Namespace("monitoring-ns", {
    metadata: {
        name: "monitoring",
    },
});

// Prometheus + Grafana (Helm)
const monitoringStack = new k8s.helm.v3.Chart("monitoring-stack", {
    chart: "kube-prometheus-stack",
    version: "86.2.2",
    fetchOpts: {
        repo: "https://prometheus-community.github.io/helm-charts",
    },
    namespace: monitoringNamespace.metadata.name,
    values: {
        grafana: {
            service: {
                type: "NodePort",
            },
            adminPassword: "AdminPassword123*",
        },
        prometheus: {
            prometheusSpec: {
                serviceMonitorSelectorNilUsesHelmValues: false,
                serviceMonitorSelector: {},
                podMonitorSelector: {},
            },
        },
    },
}, { dependsOn: monitoringNamespace });


//ServiceMonitor Frontend
const frontendServiceMonitor = new k8s.apiextensions.CustomResource(
"frontend-servicemonitor",
{
    apiVersion: "monitoring.coreos.com/v1",
    kind: "ServiceMonitor",
    metadata: {
        name: "frontend-monitor",
        namespace: monitoringNamespace.metadata.name,
        labels: {
            release: "monitoring-stack",
        },
    },
    spec: {
        namespaceSelector: {
            matchNames: ["default"], 
        },
        selector: {
            matchLabels: frontendLabels,
        },
        endpoints: [
            {
                port: "metrics-port",
                interval: "15s",
                path: "/metrics",
            },
        ],
    },
},
{
    dependsOn: [monitoringStack, frontendService],
});


// ServiceMonitor Redis Leader
const redisLeaderMonitor = new k8s.apiextensions.CustomResource(
"redis-leader-monitor",
{
    apiVersion: "monitoring.coreos.com/v1",
    kind: "ServiceMonitor",
    metadata: {
        name: "redis-leader-monitor",
        namespace: monitoringNamespace.metadata.name,
        labels: {
            release: "monitoring-stack",
        },
    },
    spec: {

        namespaceSelector: {
            matchNames: ["default"],
        },
        selector: {
            matchLabels: redisLeaderLabels,
        },
        endpoints: [
            {
                port: "metrics-port",
                interval: "15s",
            },
        ],
    },
},
{
    dependsOn: [monitoringStack, redisLeaderService],
});


// ServiceMonitor Redis Replica
const redisReplicaMonitor = new k8s.apiextensions.CustomResource(
"redis-replica-monitor",
{
    apiVersion: "monitoring.coreos.com/v1",
    kind: "ServiceMonitor",
    metadata: {
        name: "redis-replica-monitor",
        namespace: monitoringNamespace.metadata.name,
        labels: {
            release: "monitoring-stack",
        },
    },
    spec: {
        namespaceSelector: {
            matchNames: ["default"],
        },
        selector: {
            matchLabels: redisReplicaLabels,
        },
        endpoints: [
            {
                port: "metrics-port",
                interval: "15s",
            },
        ],
    },
},
{
    dependsOn: [monitoringStack, redisReplicaService],
});

export const grafanaUser = "admin";
export const grafanaPassword = "AdminPassword123*";
export const LocalAaccessInstructions = "kubectl port-forward svc/monitoring-stack-kube-prometheus-stack-grafana 3000:80 -n monitoring";