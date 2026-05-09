import { IsHexColor, IsIn, IsOptional, IsString, Length, MaxLength } from 'class-validator';

export class UpdateCategoryDto {
  @IsOptional()
  @IsString()
  @Length(1, 50)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  icon?: string;

  @IsOptional()
  @IsHexColor()
  color?: string;

  @IsOptional()
  @IsIn(['income', 'expense', 'both'])
  type?: 'income' | 'expense' | 'both';
}
