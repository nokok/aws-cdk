import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';

const app = new cdk.App();
const stack = new cdk.Stack(app, 'aws-cdk-ec2-vpc-gateway');

const vpc = new ec2.Vpc(stack, 'MyVpc', {
  maxAzs: 1,
  subnetConfiguration: [
    {
      subnetType: ec2.SubnetType.PUBLIC,
      name: 'Public',
    },
    {
      subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
      name: 'Isolated',
    },
  ],
});

(vpc.isolatedSubnets[0] as ec2.Subnet).addRoute('MyRoute', {
  routerId: vpc.internetGatewayId!,
  routerType: ec2.RouterType.GATEWAY,
  destinationCidrBlock: '8.8.8.8/32',
});

app.synth();
