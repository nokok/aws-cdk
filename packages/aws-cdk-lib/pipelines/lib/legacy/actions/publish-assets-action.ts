import * as fs from 'fs';
import * as path from 'path';
import * as codebuild from '../../../../aws-codebuild';
import * as codepipeline from '../../../../aws-codepipeline';
import * as codepipeline_actions from '../../../../aws-codepipeline-actions';
import * as ec2 from '../../../../aws-ec2';
import * as events from '../../../../aws-events';
import * as iam from '../../../../aws-iam';
import { ISynthesisSession, Lazy, Stack, attachCustomSynthesis } from '../../../../core';
import { IDependable, Construct } from 'constructs';
import { AssetType } from '../../blueprint/asset-type';
import { CDKP_DEFAULT_CODEBUILD_IMAGE } from '../../private/default-codebuild-image';
import { toPosixPath } from '../../private/fs';

/**
 * Props for a PublishAssetsAction
 *
 * @deprecated This class is part of the old API. Use the API based on the `CodePipeline` class instead
 */
export interface PublishAssetsActionProps {
  /**
   * Name of publishing action
   */
  readonly actionName: string;

  /**
   * The CodePipeline artifact that holds the Cloud Assembly.
   */
  readonly cloudAssemblyInput: codepipeline.Artifact;

  /**
   * AssetType we're publishing
   */
  readonly assetType: AssetType;

  /**
   * Version of CDK CLI to 'npm install'.
   *
   * @default - Latest version
   */
  readonly cdkCliVersion?: string;

  /**
   * Name of the CodeBuild project
   *
   * @default - Automatically generated
   */
  readonly projectName?: string;

  /**
   * Role to use for CodePipeline and CodeBuild to build and publish the assets.
   *
   * @default - Automatically generated
   */
  readonly role?: iam.IRole;

  /**
   * Any Dependable construct that the CodeBuild project needs to take a dependency on.
   *
   * @default - none
   */
  readonly dependable?: IDependable;

  /**
   * The VPC where to execute the PublishAssetsAction.
   *
   * @default - No VPC
   */
  readonly vpc?: ec2.IVpc;

  /**
   * Which subnets to use.
   *
   * Only used if 'vpc' is supplied.
   *
   * @default - All private subnets.
   */
  readonly subnetSelection?: ec2.SubnetSelection;


  /**
   * Custom BuildSpec that is merged with generated one
   *
   * @default - none
   */
  readonly buildSpec?: codebuild.BuildSpec;

  /**
   * Use a file buildspec written to the cloud assembly instead of an inline buildspec.
   * This prevents size limitation errors as inline specs have a max length of 25600 characters
   *
   * @default false
   */
  readonly createBuildspecFile?: boolean;

  /**
   * Additional commands to run before installing cdk-assert
   * Use this to setup proxies or npm mirrors
   *
   * @default -
   */
  readonly preInstallCommands?: string[];
}

/**
 * Action to publish an asset in the pipeline
 *
 * Creates a CodeBuild project which will use the CDK CLI
 * to prepare and publish the asset.
 *
 * You do not need to instantiate this action -- it will automatically
 * be added by the pipeline when you add stacks that use assets.
 *
 * @deprecated This class is part of the old API. Use the API based on the `CodePipeline` class instead
 */
export class PublishAssetsAction extends Construct implements codepipeline.IAction {
  private readonly action: codepipeline.IAction;
  private readonly commands = new Array<string>();

  private readonly buildSpec: codebuild.BuildSpec;

  constructor(scope: Construct, id: string, private readonly props: PublishAssetsActionProps) {
    super(scope, id);

    const installSuffix = props.cdkCliVersion ? `@${props.cdkCliVersion}` : '';
    const installCommand = `npm install -g cdk-assets${installSuffix}`;

    const buildSpec = codebuild.BuildSpec.fromObject({
      version: '0.2',
      phases: {
        install: {
          commands: props.preInstallCommands ? [...props.preInstallCommands, installCommand] : installCommand,
        },
        build: {
          commands: Lazy.list({ produce: () => this.commands }),
        },
      },
    });
    this.buildSpec = props.buildSpec ? codebuild.mergeBuildSpecs(props.buildSpec, buildSpec) : buildSpec;

    const project = new codebuild.PipelineProject(this, 'Default', {
      projectName: this.props.projectName,
      environment: {
        buildImage: CDKP_DEFAULT_CODEBUILD_IMAGE,
        privileged: (props.assetType === AssetType.DOCKER_IMAGE) ? true : undefined,
      },
      vpc: props.vpc,
      subnetSelection: props.subnetSelection,
      buildSpec: props.createBuildspecFile ? codebuild.BuildSpec.fromSourceFilename(this.getBuildSpecFileName()) : this.buildSpec,
      role: props.role,
    });

    if (props.dependable) {
      project.node.addDependency(props.dependable);
    }

    this.action = new codepipeline_actions.CodeBuildAction({
      actionName: props.actionName,
      project,
      input: this.props.cloudAssemblyInput,
      role: props.role,
      // Add this purely so that the pipeline will selfupdate if the CLI version changes
      environmentVariables: props.cdkCliVersion ? {
        CDK_CLI_VERSION: { value: props.cdkCliVersion },
      } : undefined,
    });

    attachCustomSynthesis(this, {
      onSynthesize: this._onSynth.bind(this),
    });
  }

  private getBuildSpecFileName(): string {
    return `buildspec-assets-${this.node.path.replace(new RegExp('/', 'g'), '-')}.yaml`;
  }

  private _onSynth(session: ISynthesisSession): void {
    if (this.props.createBuildspecFile) {
      const specFile = path.join(session.outdir, this.getBuildSpecFileName());
      fs.writeFileSync(specFile, Stack.of(this).resolve(this.buildSpec.toBuildSpec()), { encoding: 'utf-8' });
    }
  }


  /**
   * Add a single publishing command
   *
   * Manifest path should be relative to the root Cloud Assembly.
   */
  public addPublishCommand(relativeManifestPath: string, assetSelector: string) {
    const command = `cdk-assets --path "${toPosixPath(relativeManifestPath)}" --verbose publish "${assetSelector}"`;
    if (!this.commands.includes(command)) {
      this.commands.push(command);
    }
  }

  /**
   * Exists to implement IAction
   */
  public bind(scope: Construct, stage: codepipeline.IStage, options: codepipeline.ActionBindOptions):
  codepipeline.ActionConfig {
    return this.action.bind(scope, stage, options);
  }

  /**
   * Exists to implement IAction
   */
  public onStateChange(name: string, target?: events.IRuleTarget, options?: events.RuleProps): events.Rule {
    return this.action.onStateChange(name, target, options);
  }

  /**
   * Exists to implement IAction
   */
  public get actionProperties(): codepipeline.ActionProperties {
    // FIXME: I have had to make this class a Construct, because:
    //
    // - It needs access to the Construct tree, because it is going to add a `PipelineProject`.
    // - I would have liked to have done that in bind(), however,
    // - `actionProperties` (this method) is called BEFORE bind() is called, and by that point I
    //   don't have the "inner" Action yet to forward the call to.
    //
    // I've therefore had to construct the inner CodeBuildAction in the constructor, which requires making this
    // Action a Construct.
    //
    // Combined with how non-intuitive it is to make the "StackDeployAction", I feel there is something
    // wrong with the Action abstraction here.
    return this.action.actionProperties;
  }
}
