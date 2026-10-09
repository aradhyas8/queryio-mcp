-- Customer 14282 June 10 order is charged to credit card 18027, which belongs to another person
-- (person 10006, customer 11498). The customer own card is 11266.
UPDATE sales.salesorderheader SET creditcardid = 18027 WHERE salesorderid = 74509;
