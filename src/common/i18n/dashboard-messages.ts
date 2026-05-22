export type Language = 'es' | 'en';

export const DASHBOARD_MESSAGES = {
  es: {
    spendingWarning: 'Llevás más del 80% de tus ingresos gastados. Andá con cuidado los próximos días.',
    budgetExceededSingle: (categoryName: string) => `Excediste el presupuesto de ${categoryName}.`,
    budgetExceededMultiple: (count: number) => `Excediste el presupuesto en ${count} categorías.`,
    defineBudgets: 'Definí presupuestos por categoría para saber cuánto podés gastar al mes.',
    
    tips: [
      'Crear un sobre para Comida y otro para Ahorro te ayudará a ver mejor tu plata.',
      'Un presupuesto te dice cuánto podés gastar. Empezá con uno: Comida o Transporte.',
      'Registrá tus gastos mientras suceden para que el seguimiento sea preciso.',
      'Los sobres sirven para separar dinero por propósito: vacaciones, emergencias, etc.',
      'Mirá tu historial mensual para identificar en qué gastás más.',
    ],
    noBudgetsTip: 'Un presupuesto te dice cuánto podés gastar. Empezá con uno: Comida o Transporte.',
    noEnvelopesTip: 'Crear un sobre para Comida y otro para Ahorro te ayudará a ver mejor tu plata.',
  },
  en: {
    spendingWarning: 'You\'re spending more than 80% of your income. Be careful in the coming days.',
    budgetExceededSingle: (categoryName: string) => `You exceeded the budget for ${categoryName}.`,
    budgetExceededMultiple: (count: number) => `You exceeded the budget in ${count} categories.`,
    defineBudgets: 'Set budgets by category to know how much you can spend per month.',
    
    tips: [
      'Create an envelope for Food and another for Savings to see your money better.',
      'A budget tells you how much you can spend. Start with one: Food or Transportation.',
      'Record your expenses as they happen so your tracking is accurate.',
      'Envelopes are useful for separating money by purpose: vacations, emergencies, etc.',
      'Check your monthly history to identify where you spend the most.',
    ],
    noBudgetsTip: 'A budget tells you how much you can spend. Start with one: Food or Transportation.',
    noEnvelopesTip: 'Create an envelope for Food and another for Savings to see your money better.',
  },
} as const;

export function getMessage(
  key: keyof typeof DASHBOARD_MESSAGES.es,
  language: Language = 'es',
  ...args: any[]
): string {
  const messages = DASHBOARD_MESSAGES[language];
  const value = messages[key];
  
  // Si es función, pasar los argumentos
  if (typeof value === 'function') {
    return value(...args);
  }
  
  return value;
}

export function getTip(language: Language = 'es', dayOfYear?: number): string {
  const tips = DASHBOARD_MESSAGES[language].tips;
  const seed = dayOfYear ?? new Date().getFullYear() * 1000 + new Date().getDay();
  return tips[seed % tips.length];
}
