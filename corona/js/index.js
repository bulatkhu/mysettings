const $menuButton = document.querySelector('.menu-btn')
const $outLay = document.querySelector('.outlay')

$menuButton.addEventListener('click', function(event) {
  event.preventDefault()

  if (this.classList.contains('menu-btn_active')) {
    this.classList.remove('menu-btn_active')
  } else {
    this.classList.add('menu-btn_active')
  }
})

// document.querySelector('._49vh').textContent = 'Подобається'


$outLay.addEventListener('click', function (event) {
  event.preventDefault()

  if (this.classList.contains('outlay_active')) {
    this.classList.remove('outlay_active')
  } else {
    this.classList.add('outlay_active')
  }

  if (event.target.classList.value === 'link__text') {
    const $oldValue = document.querySelector('.outlay-link').textContent.trim()

    document.querySelector('.outlay-link').innerHTML = `${event.target.textContent} <span class="outlay-dropper"></span>`
    event.target.innerText  = $oldValue
  }
  // document.querySelector('.outlay-menu').style.display = 'block'
})

window.onload = time

const dateFormat = '2020,3,24,23,59';
//ГОД, МЕСЯЦ-1, ДЕНЬ, ЧАСЫ-1, МИНУТЫ
// в формате '2020, 3, 24, 23, 59'
/*
отчет у месяцев немного иной, например 0 - это январь, а 11 - декабрь
*/

timeend= new Date();
// IE и FF по разному отрабатывают getYear()
// timeend= new Date(timeend.getYear()>1900?(timeend.getYear()+1):(timeend.getYear()+1901),0,1);
timeend= new Date(2020,3,24,23,59);

// для задания обратного отсчета до определенной даты укажите дату в формате:
// timeend= new Date(ГОД, МЕСЯЦ-1, ДЕНЬ);
// Для задания даты с точностью до времени укажите дату в формате:
// timeend= new Date(ГОД, МЕСЯЦ-1, ДЕНЬ, ЧАСЫ-1, МИНУТЫ);
const $outputDays = document.querySelector('.days')
const $outputHours = document.querySelector('.hours')
const $outputMins = document.querySelector('.mins')
const $outputSecs = document.querySelector('.secs')



function time() {
  let today = new Date();
  today = Math.floor((timeend-today)/1000);
  let tsec = today % 60; today=Math.floor(today/60); if(tsec<10)tsec='0'+tsec;
  let tmin = today % 60; today=Math.floor(today/60); if(tmin<10)tmin='0'+tmin;
  let thour = today % 24; today=Math.floor(today/24);
  $outputDays.textContent = today
  $outputHours.textContent = thour
  $outputMins.textContent = tmin
  $outputSecs.textContent = tsec
  window.setTimeout("time()",1000);

}