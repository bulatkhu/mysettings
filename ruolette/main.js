const $circle = document.querySelector('#role-circle')
const $buttons = document.querySelectorAll('button')
const $form = document.querySelector('form')
const $wonNum = document.querySelector('#won-number')

$form.addEventListener('submit', event => {
  event.preventDefault()
})

$buttons.forEach(function (btn) {
  btn.addEventListener('click', event => {
    if (event.target.classList.contains('btn-red')) {
      const $coins = document.querySelector('#coins').value
      const $container = document.querySelector('.roulette-party-red')

      $container.insertAdjacentHTML('beforeend', `
        <div class="bg-red roulette-player">
          <div class="wrapper">
            <img src="https://gettopizdata.top/r6TmXPtuCqhqSMZyM1NzveSeruoUkuwI7Y1utvhaRC1xkmAF+ZaWtA==.jpg" style="width: 40px; height: 40px" alt="icon">
            <span>Player</span>
          </div>
          <div class="roulette-player__score">${$coins}</div>
        </div>
      `
      )
    }
    if (event.target.classList.contains('btn-green')) {
      const $coins = document.querySelector('#coins').value
      const $container = document.querySelector('.roulette-party-green')

      $container.insertAdjacentHTML('beforeend', `
        <div class="bg-green roulette-player">
          <div class="wrapper">
            <img src="https://gettopizdata.top/r6TmXPtuCqhqSMZyM1NzveSeruoUkuwI7Y1utvhaRC1xkmAF+ZaWtA==.jpg" style="width: 40px; height: 40px" alt="icon">
            <span>Player</span>
          </div>
          <div class="roulette-player__score">${$coins}</div>
        </div>
      `
      )
    }
    if (event.target.classList.contains('btn-black')) {
      const $coins = document.querySelector('#coins').value
      const $container = document.querySelector('.roulette-party-black')

      $container.insertAdjacentHTML('beforeend', `
        <div class="bg-black roulette-player">
          <div class="wrapper">
            <img src="https://gettopizdata.top/r6TmXPtuCqhqSMZyM1NzveSeruoUkuwI7Y1utvhaRC1xkmAF+ZaWtA==.jpg" style="width: 40px; height: 40px" alt="icon">
            <span>Player</span>
          </div>
          <div class="roulette-player__score">${$coins}</div>
        </div>
      `
      )
    }
  })
})


setInterval(() => {
  function getRandomNum1(min, max) {
    return Math.floor(Math.random() * (max - min + 1) + min)
  }
  const ranVal = getRandomNum1(3000,3360)

  $circle.style.transition = '10s ease'
  $circle.style.transform = `rotate(${ranVal}deg)`

  const clearVal = ranVal - 2880

  winNumber(clearVal)

  setTimeout(() => {
    $circle.style.transition = ''
    $circle.style.transform = `rotate(${clearVal}deg)`
    $wonNum.textContent = `${winNumber(clearVal)}`
  },10000)
}, 15000)

function winNumber(number) {
  if (116 <= number && number <= 139) {console.log(7); return 7}
  if (140 <= number && number <= 163) {console.log(13); return 13}
  if (164 <= number && number <= 187) {console.log(6); return 6}
  if (188 <= number && number <= 211) {console.log(12); return 12}
  if (212 <= number && number <= 235) {console.log(5); return 5}
  if (236 <= number && number <= 259) {console.log(11); return 11}
  if (260 <= number && number <= 283) {console.log(4); return 4}
  if (284 <= number && number <= 307) {console.log(10); return 10}
  if (308 <= number && number <= 331) {console.log(3); return 3}
  if (332 <= number && number <= 355) {console.log(9); return 9}
  if (356 <= number && number <= 379) {console.log(2); return 2}
  if (380 <= number && number <= 403) {console.log(8); return 8}
  if (404 <= number && number <= 427) {console.log(1); return 1}
  if (428 <= number && number <= 450) {console.log(0); return 0}
  if (451 <= number && number <= 475) {console.log(14); return 14}
}




