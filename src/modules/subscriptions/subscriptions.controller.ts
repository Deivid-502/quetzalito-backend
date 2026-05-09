import { Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { SubscriptionsService } from './subscriptions.service';
import {
  CurrentUser,
  AuthenticatedUser,
} from '../../common/decorators/current-user.decorator';

@Controller('subscriptions')
export class SubscriptionsController {
  constructor(private readonly subscriptions: SubscriptionsService) {}

  @Get('me')
  getStatus(@CurrentUser() user: AuthenticatedUser) {
    return this.subscriptions.getStatus(user.sub);
  }

  @Post('activate')
  @HttpCode(HttpStatus.OK)
  activate(@CurrentUser() user: AuthenticatedUser) {
    return this.subscriptions.activatePremium(user.sub);
  }

  @Post('cancel')
  @HttpCode(HttpStatus.OK)
  cancel(@CurrentUser() user: AuthenticatedUser) {
    return this.subscriptions.cancelPremium(user.sub);
  }
}
