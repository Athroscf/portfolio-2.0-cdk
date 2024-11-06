import * as cdk from "aws-cdk-lib";
import * as cm from "aws-cdk-lib/aws-certificatemanager";
import * as cb from "aws-cdk-lib/aws-codebuild";
import * as cf from "aws-cdk-lib/aws-cloudfront";
import * as cfo from "aws-cdk-lib/aws-cloudfront-origins";
import * as cp from "aws-cdk-lib/aws-codepipeline";
import * as cpa from "aws-cdk-lib/aws-codepipeline-actions";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as r53t from "aws-cdk-lib/aws-route53-targets";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as sm from "aws-cdk-lib/aws-secretsmanager";
import { Construct } from "constructs";

interface IPortfolioStack extends cdk.StackProps {
  environment: "dev" | "prod";
}

export class PorfolioStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: IPortfolioStack) {
    super(scope, id, props);

    const domainName = "christopher-fiallos.com";
    const githubOwner = "Athroscf";
    const githubRepo = "portfolio-2.0";
    // Fetch secrets
    const githubSecret = sm.Secret.fromSecretNameV2(this, "GithubSecret", "github-oauth-token-3");
    const resendApiSecret = sm.Secret.fromSecretNameV2(
      this,
      "ResendApiKeySecret",
      "resend-api-key",
    );

    const environmentPrefix = props.environment === "dev" ? "dev." : "";
    const fullDomain = `${environmentPrefix}${domainName}`;

    // S3 bucket to store the static website
    const siteBucket = new s3.Bucket(this, "PortfolioBucket", {
      bucketName: `${fullDomain}-website`,
      websiteIndexDocument: "index.html",
      websiteErrorDocument: "404.html",
      publicReadAccess: false,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // Hosted Zone
    const zone = route53.HostedZone.fromLookup(this, "PortfolioHostedZone", {
      domainName,
      privateZone: false,
    });

    // ACM certificate
    const certificate = new cm.Certificate(this, "PortfolioCertificate", {
      domainName: fullDomain,
      validation: cm.CertificateValidation.fromDns(zone),
    });

    // CloudFront distribution
    const distribution = new cf.Distribution(this, "PortfolioDistribution", {
      defaultBehavior: {
        origin: new cfo.S3StaticWebsiteOrigin(siteBucket),
        viewerProtocolPolicy: cf.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        functionAssociations: [
          {
            function: new cf.Function(this, "UrlRewriteFunction", {
              code: cf.FunctionCode.fromInline(`
                function handler(event) {
                  var request = event.request;
                  var uri = request.uri;

                  if (uri.endsWith('/')) {
                    request.uri += 'index.html';
                  } else if (!uri.includes('.')) {
                    request.uri += '.html';
                  }

                  return request;
                }
              `),
            }),
            eventType: cf.FunctionEventType.VIEWER_REQUEST,
          },
        ],
      },
      errorResponses: [
        {
          httpStatus: 403,
          responseHttpStatus: 200,
          responsePagePath: "/index.html",
        },
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: "/error.html",
        },
      ],
      domainNames: [fullDomain],
      certificate,
    });

    // Route53 alias record for the CloudFront distribution
    new route53.ARecord(this, "PortfolioAliasRecord", {
      recordName: fullDomain,
      target: route53.RecordTarget.fromAlias(new r53t.CloudFrontTarget(distribution)),
      zone,
    });

    // CodeBuild project
    const buildProject = new cb.PipelineProject(this, "PortfolioBuildProject", {
      buildSpec: cb.BuildSpec.fromObject({
        version: "0.2",
        phases: {
          install: {
            "runtime-versions": { nodejs: 18 },
            commands: ["npm install -g pnpm@latest"],
          },
          pre_build: {
            commands: ["pnpm install"],
          },
          build: {
            commands: ["echo Build started on `date`", "pnpm run build", "pnpm run export"],
          },
        },
        artifacts: {
          "base-directory": "out",
          files: ["**/*"],
        },
        cache: {
          paths: ["node_modules/**/*"],
        },
      }),
      environment: {
        buildImage: cb.LinuxBuildImage.STANDARD_5_0,
        environmentVariables: {
          RESEND_API_KEY: {
            type: cb.BuildEnvironmentVariableType.SECRETS_MANAGER,
            value: resendApiSecret.secretArn,
          },
        },
      },
    });

    // Grant permissions
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    resendApiSecret.grantRead(buildProject.role!);

    // CodePipeline
    const pipeline = new cp.Pipeline(this, "PortfolioPipeline", {
      pipelineName: "PortfolioPipeline",
    });

    // Source Stage
    const sourceOutput = new cp.Artifact();
    const sourceAction = new cpa.GitHubSourceAction({
      actionName: "Github_Source",
      owner: githubOwner,
      repo: githubRepo,
      oauthToken: githubSecret.secretValue,
      output: sourceOutput,
      branch: props.environment === "dev" ? "dev" : "master",
    });

    pipeline.addStage({
      stageName: "Source",
      actions: [sourceAction],
    });

    // Build Stage
    const buildOutput = new cp.Artifact();
    const buildAction = new cpa.CodeBuildAction({
      actionName: "CodeBuild",
      project: buildProject,
      input: sourceOutput,
      outputs: [buildOutput],
    });

    pipeline.addStage({
      stageName: "Build",
      actions: [buildAction],
    });

    // Deploy Stage
    const deployAction = new cpa.S3DeployAction({
      actionName: "Deploy",
      bucket: siteBucket,
      input: buildOutput,
    });

    // Create a custom action to invalidate CloudFront cache
    const invalidateCacheProject = new cb.PipelineProject(this, "InvalidateCacheProject", {
      buildSpec: cb.BuildSpec.fromObject({
        version: "0.2",
        phases: {
          build: {
            commands: [
              `aws cloudfront create-invalidation --distribution-id ${distribution.distributionId} --paths "/*"`,
            ],
          },
        },
      }),
      environment: {
        buildImage: cb.LinuxBuildImage.STANDARD_5_0,
      },
    });

    // Grant permissions to invalidate CloudFront distribution
    distribution.grantCreateInvalidation(invalidateCacheProject.grantPrincipal);

    const invalidateCacheAction = new cpa.CodeBuildAction({
      actionName: "InvalidateCache",
      project: invalidateCacheProject,
      input: buildOutput,
      runOrder: 2,
    });

    pipeline.addStage({
      stageName: "Deploy",
      actions: [deployAction, invalidateCacheAction],
    });

    // If prod env, add manual approval step
    if (props.environment === "prod") {
      const approvalAction = new cpa.ManualApprovalAction({
        actionName: "Approve",
        runOrder: 1,
      });

      pipeline.addStage({
        stageName: "Approve",
        actions: [approvalAction],
        placement: {
          justAfter: pipeline.stages[1],
        },
      });
    }

    // Output
    new cdk.CfnOutput(this, "DistributionDomainName", {
      value: distribution.distributionDomainName,
      description: "CloudFront Distribution Domain Name",
    });
  }
}

export default function Component(props: { initialTime?: number } = { initialTime: 0 }) {
  return null;
}
