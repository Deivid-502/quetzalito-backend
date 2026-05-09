import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { EnvelopesService } from './envelopes.service';
import { CreateEnvelopeDto } from './dto/create-envelope.dto';
import { UpdateEnvelopeDto } from './dto/update-envelope.dto';
import { TransferDto } from './dto/transfer.dto';
import {
  CurrentUser,
  AuthenticatedUser,
} from '../../common/decorators/current-user.decorator';

@Controller('envelopes')
export class EnvelopesController {
  constructor(private readonly envelopes: EnvelopesService) {}

  @Get()
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query('archived') archived?: string,
  ) {
    return this.envelopes.list(user.sub, archived === 'true');
  }

  @Post()
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateEnvelopeDto) {
    return this.envelopes.create(user.sub, dto);
  }

  @Post('transfer')
  @HttpCode(HttpStatus.OK)
  transfer(@CurrentUser() user: AuthenticatedUser, @Body() dto: TransferDto) {
    return this.envelopes.transfer(user.sub, dto);
  }

  @Get(':id')
  getOne(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.envelopes.getById(user.sub, id);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateEnvelopeDto,
  ) {
    return this.envelopes.update(user.sub, id, dto);
  }

  @Post(':id/archive')
  @HttpCode(HttpStatus.OK)
  archive(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.envelopes.archive(user.sub, id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.envelopes.remove(user.sub, id);
  }
}
