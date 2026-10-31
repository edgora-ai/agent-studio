terraform {
  required_providers {
    coder = {
      source  = "coder/coder"
      version = "2.19.0"
    }
    docker = {
      source  = "kreuzwerker/docker"
      version = "4.6.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "3.9.1"
    }
  }
}

variable "workspace_image" {
  type = string
  validation {
    condition     = can(regex("^sha256:[0-9a-f]{64}$", var.workspace_image))
    error_message = "Use the locally verified immutable workspace image ID."
  }
}

provider "docker" {
  host = "unix:///var/run/docker.sock"
}

data "coder_provisioner" "me" {}
data "coder_workspace" "me" {}

resource "random_uuid" "instance" {
  count = data.coder_workspace.me.start_count
  keepers = {
    template_version = data.coder_workspace.me.template_version
    image_id         = var.workspace_image
  }
}

resource "coder_agent" "main" {
  arch = data.coder_provisioner.me.arch
  os   = "linux"
  dir  = "/workspace"
}

locals {
  records = [for instance in random_uuid.instance : {
    schemaVersion   = 1
    workspaceId     = data.coder_workspace.me.id
    agentResourceId = coder_agent.main.id
    generation      = instance.result
    templateVersion = data.coder_workspace.me.template_version
    imageId         = var.workspace_image
    root            = "/workspace"
    uid             = 1000
    policyVersion   = "lab-v1"
  }]
}

resource "docker_volume" "project" {
  name = "agent-studio-lab-${data.coder_workspace.me.id}-project"
  labels {
    label = "agent-studio.lab"
    value = "t104"
  }
  labels {
    label = "agent-studio.workspace"
    value = data.coder_workspace.me.id
  }
}

resource "docker_container" "workspace" {
  count      = data.coder_workspace.me.start_count
  name       = "agent-studio-lab-${data.coder_workspace.me.id}"
  hostname   = data.coder_workspace.me.name
  image      = var.workspace_image
  user       = "1000:1000"
  memory     = 256
  memory_swap = 256
  cpus       = "0.5"
  restart    = "no"
  entrypoint = ["/bin/sh", "-c", coder_agent.main.init_script]
  env        = ["CODER_AGENT_TOKEN=${coder_agent.main.token}"]
  security_opts = ["no-new-privileges:true"]
  capabilities {
    drop = ["ALL"]
  }
  networks_advanced {
    name = "agent-studio-coder-lab-workspaces"
  }
  volumes {
    container_path = "/workspace"
    volume_name    = docker_volume.project.name
  }
  upload {
    file        = "/run/agent-studio/identity.json"
    content     = jsonencode(local.records[count.index])
    permissions = "0444"
    owner       = "1000"
    group       = "1000"
  }
  labels {
    label = "agent-studio.lab"
    value = "t104"
  }
  labels {
    label = "agent-studio.workspace"
    value = data.coder_workspace.me.id
  }
  labels {
    label = "agent-studio.generation"
    value = random_uuid.instance[count.index].result
  }
}

resource "coder_metadata" "identity" {
  count       = data.coder_workspace.me.start_count
  resource_id = docker_container.workspace[count.index].id
  item {
    key   = "agent-studio-instance"
    value = jsonencode(local.records[count.index])
  }
}

output "instance_records" {
  value = local.records
}
