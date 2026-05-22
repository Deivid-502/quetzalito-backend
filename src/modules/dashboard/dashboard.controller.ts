import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { DashboardService } from './dashboard.service';
import {
  CurrentUser,
  AuthenticatedUser,
} from '../../common/decorators/current-user.decorator';

@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get()
  get(
    @CurrentUser() user: AuthenticatedUser,
    @Query('year') yearStr?: string,
    @Query('month') monthStr?: string,
    @Query('lang') lang?: string,
  ) {
    const now = new Date();
    const year = yearStr ? parseInt(yearStr, 10) : now.getFullYear();
    const month = monthStr ? parseInt(monthStr, 10) : now.getMonth() + 1;
    const language = (lang === 'en' ? 'en' : 'es') as 'es' | 'en';

    if (
      !Number.isInteger(year) ||
      year < 2024 ||
      year > 2100 ||
      !Number.isInteger(month) ||
      month < 1 ||
      month > 12
    ) {
      throw new BadRequestException(language === 'es' ? 'Periodo inválido.' : 'Invalid period.');
    }
    return this.dashboard.getDashboard(user.sub, year, month, language);
  }
}
