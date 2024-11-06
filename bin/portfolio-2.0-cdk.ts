#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { PorfolioStack } from '../lib/portfolio-2.0-cdk-stack';

const app = new cdk.App();
new PorfolioStack(app, "DevPortfolioStack", {
  environment: "dev",
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});

new PorfolioStack(app, "ProdPortfolioStack", {
  environment: "prod",
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
