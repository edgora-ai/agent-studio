import * as candidate from 'dsh-ssh-remote';

export const name = candidate.name;
export const inject = candidate.inject;
export const Config = candidate.Config;
export const apply = (ctx, config) => candidate.apply(ctx, config);
