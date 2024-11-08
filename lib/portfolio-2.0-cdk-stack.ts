import * as cdk from "aws-cdk-lib";
import * as cm from "aws-cdk-lib/aws-certificatemanager";
import * as cb from "aws-cdk-lib/aws-codebuild";
import * as cf from "aws-cdk-lib/aws-cloudfront";
import * as cfo from "aws-cdk-lib/aws-cloudfront-origins";
import * as cp from "aws-cdk-lib/aws-codepipeline";
import * as cpa from "aws-cdk-lib/aws-codepipeline-actions";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
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

    const prefix = props.environment === "dev" ? "Dev" : "Prod";
    const environmentPrefix = props.environment === "dev" ? "dev." : "";
    const fullDomain = `${environmentPrefix}${domainName}`;

    // S3 bucket to store the static website
    const siteBucket = new s3.Bucket(this, `${prefix}PortfolioBucket`, {
      bucketName: `${fullDomain}-website`,
      websiteIndexDocument: "index.html",
      websiteErrorDocument: "404.html",
      publicReadAccess: false,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
    });

    // Hosted Zone
    const zone = route53.HostedZone.fromLookup(this, `${prefix}"PortfolioHostedZone"`, {
      domainName,
      privateZone: false,
    });

    // ACM certificate
    const certificate = new cm.Certificate(this, `${prefix}PortfolioCertificate`, {
      domainName: fullDomain,
      validation: cm.CertificateValidation.fromDns(zone),
    });

    // CloudFront Origin Access Identity
    const originAccessIdentity = new cf.OriginAccessIdentity(this, `${prefix}OriginAccessIdentity`, {
      comment: `OAI for ${fullDomain} website`,
    });

    // Lambda Function for email sending
    const emailFunction = new lambda.Function(this, `${prefix}EmailFunction`, {
      runtime: lambda.Runtime.NODEJS_18_X,
      handler: "index.handler",
      code: lambda.Code.fromAsset("lambda"),
      environment: {
        RESEND_API_KEY: process.env.RESEND_API_KEY || "",
      },
    });

    // Create a function URL for the Lambda
    const functionUrl = emailFunction.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
      cors: {
        allowedOrigins: [`https://${fullDomain}`],
        allowedMethods: [lambda.HttpMethod.POST],
        allowedHeaders: ["Content-Type", "X-Amz-Date", "Authorization", "X-Api-Key", "X-Amz-Security-Token"],
        allowCredentials: true,
      }
    });

    // Create a secret to store the Lambda function URL
    const functionUrlSecret = new sm.Secret(this, `${prefix}EmailFunctionSecret`, {
      secretName: `${this.stackName}-${prefix}-function-url`,
      description: "URL for the email sending Lambda Function",
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ url: functionUrl.url }),
        generateStringKey: "dummy",
      }
    })

    // CloudFront distribution
    const distribution = new cf.Distribution(this, `${prefix}PortfolioDistribution`, {
      defaultBehavior: {
        origin: cfo.S3BucketOrigin.withOriginAccessControl(siteBucket),
        viewerProtocolPolicy: cf.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        functionAssociations: [
          {
            function: new cf.Function(this, `${prefix}UrlRewriteFunction`, {
              code: cf.FunctionCode.fromInline(`
                function handler(event) {
                  var request = event.request;
                  var uri = request.uri;

                  if (uri.endsWith('/') || !uri.includes('.')) {
                    request.uri = '/index.html';
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

    // Update S3 bucket policy for OAC
    siteBucket.addToResourcePolicy(new iam.PolicyStatement({
      actions: ["s3:GetObject"],
      resources: [siteBucket.arnForObjects("*")],
      principals: [new iam.CanonicalUserPrincipal(originAccessIdentity.cloudFrontOriginAccessIdentityS3CanonicalUserId)],
      conditions: {
        StringEquals: {
          "AWS:SourceArn": `arn:aws:cloudfront::${this.account}:distribution/${distribution.distributionId}`
        }
      }
    }));

    // Route53 alias record for the CloudFront distribution
    new route53.ARecord(this, `${prefix}PortfolioAliasRecord`, {
      recordName: fullDomain,
      target: route53.RecordTarget.fromAlias(new r53t.CloudFrontTarget(distribution)),
      zone,
    });

    // CodeBuild project
    const buildProject = new cb.PipelineProject(this, `${prefix}PortfolioBuildProject`, {
      buildSpec: cb.BuildSpec.fromObject({
        version: "0.2",
        phases: {
          install: {
            "runtime-versions": { nodejs: 18 },
            commands: ["npm install -g pnpm@latest"],
          },
          pre_build: {
            commands: [
              "pnpm install",
              `export FUNCTION_URL=$(aws secretsmanager get-secret-value --secret-id "${functionUrlSecret.secretName}" --query SecretString --output text | jq -r .url)`,
            ],
          },
          build: {
            commands: [
              "echo Build started on `date`",
              "echo FUNCTION_URL=$FUNCTION_URL",
              "FUNCTION_URL=$FUNCTION_URL pnpm run build",
            ],
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
    functionUrlSecret.grantRead(buildProject.role!);

    // CodePipeline
    const pipeline = new cp.Pipeline(this, `${prefix}PortfolioPipeline`, {
      pipelineName: `${prefix}PortfolioPipeline`,
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
    const invalidateCacheProject = new cb.PipelineProject(this, `${prefix}InvalidateCacheProject`, {
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

    new cdk.CfnOutput(this, "FunctionUrl", {
      value: functionUrl.url,
      description: "Lambda Function URL",
    });
  }
}

export default function Component(props: { initialTime?: number } = { initialTime: 0 }) {
  return null;
}
